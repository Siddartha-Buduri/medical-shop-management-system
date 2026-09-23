// server.js (Sprint 2)
const oracledb = require("oracledb");

try {
  oracledb.initOracleClient({ libDir: "C:\\oracleclient\\instantclient_11_2" });
  console.log("Oracle Instant Client initialized successfully.");
} catch (err) {
  console.error("Could not initialize Oracle Instant Client!", err);
  process.exit(1);
}

const express = require("express");
const cors = require("cors");
const dbConfig = require("./db-config.js");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Helper for SELECT queries
async function runQuery(sql, binds = []) {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const result = await connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return result.rows;
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error(err); }
    }
  }
}

// Sprint 2: Login Endpoint (No Password Change)
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const sql = `SELECT * FROM Login WHERE username = :username AND password = :password`;
    const rows = await runQuery(sql, [username, password]);
    
    if (rows.length === 1) {
      const user = {
          ...rows[0],
          EMPLOYEE_ID: rows[0].EMPLOYEE_ID || 'E001',
          USERNAME: rows[0].USERNAME
      };
      res.json({ success: true, user: user });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Inventory Endpoint (Updated for Sprint 2: Needs Search functionality for the billing page)
app.get("/api/inventory", async (req, res) => {
  try {
    const { search } = req.query;
    let sql = `
      SELECT i.inventory_id, i.batch_number, i.quantity, i.expiry_date, m.medicine_id, m.medicine_name, m.unit_price
      FROM Inventory i JOIN Medicines m ON i.medicine_id = m.medicine_id
      WHERE i.quantity > 0
    `;
    const binds = [];
    if (search) {
      sql += " AND (UPPER(m.medicine_name) LIKE :1 OR UPPER(i.batch_number) LIKE :2)";
      binds.push(`%${search.toUpperCase()}%`, `%${search.toUpperCase()}%`);
    }
    sql += " ORDER BY m.medicine_name, i.expiry_date";
    res.json(await runQuery(sql, binds));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Medicines Endpoint (Carried over from Sprint 1)
app.get("/api/medicines", async (req, res) => {
    try {
        let sql = `SELECT * FROM Medicines ORDER BY medicine_name`;
        res.json(await runQuery(sql));
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Sprint 2: The Core Billing Engine (Handles multiple inserts and inventory updates)
app.post("/api/billing", async (req, res) => {
    let transConnection;
    let isTransactionStarted = false;
    try {
        const { employee_id, payment_method, customer_fname, customer_lname, customer_phone, items } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ success: false, message: "No items in the bill." });
        
        transConnection = await oracledb.getConnection();
        let totalAmount = 0; 
        const itemsWithPrice = [];
        
        // Step 1: Validate items and lock rows
        for (const item of items) {
            const priceQuery = `SELECT m.unit_price, i.quantity FROM Medicines m JOIN Inventory i ON m.medicine_id = i.medicine_id WHERE i.inventory_id = :1 FOR UPDATE WAIT 5`;
            const result = await transConnection.execute(priceQuery, [item.inventory_id], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false });
            isTransactionStarted = true;
            
            if (result.rows.length === 0) throw new Error(`Item ${item.inventory_id} not found.`);
            const { UNIT_PRICE: unit_price, QUANTITY: stock_quantity } = result.rows[0];
            if (item.qty_sold > stock_quantity) throw new Error(`Not enough stock for ${item.inventory_id}.`);
            
            totalAmount += unit_price * Number(item.qty_sold);
            itemsWithPrice.push({ ...item, qty_sold: Number(item.qty_sold), unit_price_at_sale: unit_price });
        }

        // Step 2: Create Transaction Record
        const transactionId = "T" + Date.now();
        await transConnection.execute(`INSERT INTO Transactions (transaction_id, employee_id, total_amount, payment_method) VALUES (:1, :2, :3, :4)`, [transactionId, employee_id, totalAmount, payment_method]);
        
        // Step 3: Insert Items & Deduct Inventory
        for (const item of itemsWithPrice) {
            const transItemId = "TI" + Date.now() + Math.random().toString(36).substring(2, 6);
            await transConnection.execute(`INSERT INTO Transaction_Item (transaction_item_id, transaction_id, inventory_id, qty_sold, unit_price_at_sale) VALUES (:1, :2, :3, :4, :5)`, [transItemId, transactionId, item.inventory_id, item.qty_sold, item.unit_price_at_sale]);
            await transConnection.execute(`UPDATE Inventory SET quantity = quantity - :1 WHERE inventory_id = :2`, [item.qty_sold, item.inventory_id]);
        }
        
        // Step 4: Create Billing (Customer) Record
        const billingId = "B" + Date.now();
        await transConnection.execute(`INSERT INTO Billing (billing_id, transaction_id, customer_fname, customer_lname, customer_phone) VALUES (:1, :2, :3, :4, :5)`, [billingId, transactionId, customer_fname, customer_lname, customer_phone]);
        
        // Step 5: Commit DB Transaction
        await transConnection.commit();
        res.json({ success: true, message: "Billing complete!" });
        
    } catch (err) {
        console.error("Billing Error:", err);
        if (transConnection && isTransactionStarted) {
            try { await transConnection.rollback(); } catch (rollErr) { console.error("Rollback failed:", rollErr); }
        }
        res.status(500).json({ success: false, message: err.message });
    } finally {
        if (transConnection) {
            try { await transConnection.close(); } catch (closeErr) { console.error("Failed to close TX conn:", closeErr); }
        }
    }
});

async function startServer() {
  await oracledb.createPool({...dbConfig, poolMin: 0, poolMax: 4});
  app.listen(PORT, () => console.log(`Sprint 2 Server running on port ${PORT}`));
}
startServer();