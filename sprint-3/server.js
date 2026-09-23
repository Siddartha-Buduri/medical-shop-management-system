// server.js
const oracledb = require("oracledb");

// --- Initialize Oracle Client (Thick Mode) ---
try {
  oracledb.initOracleClient({ libDir: "C:\\oracleclient\\instantclient_11_2" });
  console.log("Oracle Instant Client initialized successfully.");
} catch (err) {
  console.error("Could not initialize Oracle Instant Client!");
  console.error(err);
  process.exit(1);
}
// --- END ---

const express = require("express");
const cors = require("cors");
const dbConfig = require("./db-config.js"); // Your DB credentials

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// --- Helper function to run SELECT queries (returns rows) ---
async function runQuery(sql, binds = []) {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const result = await connection.execute(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return result.rows;
  } catch (err) {
    console.error("SQL Error in runQuery:", err);
    throw err;
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error("Error closing connection in runQuery:", err);
      }
    }
  }
}

// --- Helper function for DML (INSERT, UPDATE, DELETE) ---
async function runDMLQuery(sql, binds = []) {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const result = await connection.execute(sql, binds, {
      autoCommit: true,
    });
    return result.rowsAffected;
  } catch (err) {
    console.error("SQL Error in runDMLQuery:", err);
    throw err;
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error("Error closing connection in runDMLQuery:", err);
      }
    }
  }
}


// --- API Endpoints ---

// Login Endpoint
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const sql = `SELECT * FROM Login WHERE username = :username AND password = :password`;
    const rows = await runQuery(sql, [username, password]);
    if (rows.length === 1) {
      const user = {
          ...rows[0],
          EMPLOYEE_ID: rows[0].EMPLOYEE_ID || 'E001', // Fallback ID
          USERNAME: rows[0].USERNAME // Ensure USERNAME is returned
      };
      console.log(`Login successful for user: ${user.USERNAME}`);
      res.json({ success: true, user: user });
    } else {
      console.warn(`Login failed for user: ${username}`);
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  } catch (err) {
    console.error(`Login error for user ${req.body.username}:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Change Password Endpoint
app.put("/api/change-password", async (req, res) => {
    const { username, old_password, new_password } = req.body;
    let connection;
    try {
        connection = await oracledb.getConnection();
        // Verify old password
        const verifySql = `SELECT * FROM Login WHERE username = :1 AND password = :2`;
        const verifyResult = await connection.execute(verifySql, [username, old_password]);
        if (verifyResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: "Incorrect old password." });
        }
        // Update to new password
        const updateSql = `UPDATE Login SET password = :1 WHERE username = :2`;
        const updateResult = await connection.execute(updateSql, [new_password, username], {
            autoCommit: true
        });
        if (updateResult.rowsAffected === 0) {
            throw new Error("Failed to update password, user not found.");
        }
        res.json({ success: true, message: "Password changed successfully." });
    } catch (err) {
        console.error(`Password change error for ${username}:`, err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        if (connection) {
            try { await connection.close(); }
            catch (closeErr) { console.error("Error closing connection:", closeErr); }
        }
    }
});

// Inventory Endpoint (with search)
app.get("/api/inventory", async (req, res) => {
  try {
    const { search } = req.query;
    let sql = `
      SELECT
        i.inventory_id, i.batch_number, i.quantity, i.expiry_date,
        m.medicine_id, m.medicine_name, m.unit_price
      FROM Inventory i JOIN Medicines m ON i.medicine_id = m.medicine_id
      WHERE i.quantity > 0
    `;
    const binds = [];
    if (search) {
      sql += " AND (UPPER(m.medicine_name) LIKE :1 OR UPPER(i.batch_number) LIKE :2)";
      binds.push(`%${search.toUpperCase()}%`);
      binds.push(`%${search.toUpperCase()}%`);
    }
    sql += " ORDER BY m.medicine_name, i.expiry_date";
    const rows = await runQuery(sql, binds);
    res.json(rows);
  } catch (err) {
     console.error("Error fetching inventory:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Quick Add Stock Endpoint
app.post("/api/inventory/quick-add", async (req, res) => {
    try {
        const { medicine_id, quantity, expiry_date, batch_number, supplier_id, purchase_date } = req.body;

        if (!medicine_id || !quantity || !expiry_date || !batch_number || !supplier_id || !purchase_date) {
            return res.status(400).json({ success: false, message: "Missing required fields for adding stock." });
        }
        const inventory_id = 'INV' + Date.now();
        const sql = `INSERT INTO Inventory
                        (inventory_id, medicine_id, supplier_id, batch_number, quantity, expiry_date, purchase_date)
                     VALUES
                        (:1, :2, :3, :4, :5, TO_DATE(:6, 'YYYY-MM-DD'), TO_DATE(:7, 'YYYY-MM-DD'))`;
        const binds = [ inventory_id, medicine_id, supplier_id, batch_number, parseInt(quantity, 10), expiry_date, purchase_date ];
        const rowsAffected = await runDMLQuery(sql, binds);
        res.status(201).json({ success: true, rowsAffected, inventory_id });
    } catch (err) {
        console.error("Error adding stock:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Billing Endpoint
app.post("/api/billing", async (req, res) => {
    let transConnection;
    let isTransactionStarted = false;
    try {
        const { employee_id, payment_method, customer_fname, customer_lname, customer_phone, items } = req.body;
        if (!items || items.length === 0) { return res.status(400).json({ success: false, message: "No items in the bill." }); }
        transConnection = await oracledb.getConnection();
        let totalAmount = 0; const itemsWithPrice = [];
        // Step 1: Validate items, get prices, calculate total
        for (const item of items) {
            const priceQuery = `SELECT m.unit_price, i.quantity FROM Medicines m JOIN Inventory i ON m.medicine_id = i.medicine_id WHERE i.inventory_id = :1 FOR UPDATE WAIT 5`;
            const executeOptions = { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false };
            const result = await transConnection.execute(priceQuery, [item.inventory_id], executeOptions);
            isTransactionStarted = true;
            if (result.rows.length === 0) throw new Error(`Item ${item.inventory_id} not found.`);
            const { UNIT_PRICE: unit_price, QUANTITY: stock_quantity } = result.rows[0];
            if (typeof unit_price !== 'number' || typeof stock_quantity !== 'number') { throw new Error(`Invalid price/qty type for item ${item.inventory_id}`); }
            if (item.qty_sold > stock_quantity) { throw new Error(`Not enough stock for ${item.inventory_id}. Avail: ${stock_quantity}, Req: ${item.qty_sold}`); }
            const quantitySold = Number(item.qty_sold);
            if (isNaN(quantitySold) || quantitySold <= 0) { throw new Error(`Invalid qty for ${item.inventory_id}: ${item.qty_sold}`); }
            totalAmount += unit_price * quantitySold;
            itemsWithPrice.push({ ...item, qty_sold: quantitySold, unit_price_at_sale: unit_price });
        }
        // Step 2: Create Transaction
        const transactionId = "T" + Date.now();
        const transInsertSql = `INSERT INTO Transactions (transaction_id, employee_id, total_amount, payment_method) VALUES (:1, :2, :3, :4)`;
        await transConnection.execute(transInsertSql, [transactionId, employee_id, totalAmount, payment_method]);
        // Step 3: Insert Transaction Items & Update Inventory
        for (const item of itemsWithPrice) {
            const transItemId = "TI" + Date.now() + Math.random().toString(36).substring(2, 8);
            const transItemInsertSql = `INSERT INTO Transaction_Item (transaction_item_id, transaction_id, inventory_id, qty_sold, unit_price_at_sale) VALUES (:1, :2, :3, :4, :5)`;
            await transConnection.execute(transItemInsertSql, [transItemId, transactionId, item.inventory_id, item.qty_sold, item.unit_price_at_sale]);
            const inventoryUpdateSql = `UPDATE Inventory SET quantity = quantity - :1 WHERE inventory_id = :2`;
            const updateResult = await transConnection.execute(inventoryUpdateSql, [item.qty_sold, item.inventory_id]);
            if (updateResult.rowsAffected === 0) { console.warn(`Inventory update 0 rows for ${item.inventory_id}. Race condition?`); }
        }
        // Step 4: Create Bill
        const billingId = "B" + Date.now();
        const billingInsertSql = `INSERT INTO Billing (billing_id, transaction_id, customer_fname, customer_lname, customer_phone) VALUES (:1, :2, :3, :4, :5)`;
        await transConnection.execute(billingInsertSql, [billingId, transactionId, customer_fname, customer_lname, customer_phone]);
        // Step 5: Commit
        await transConnection.commit();
        res.json({ success: true, message: "Billing complete!", transactionId: transactionId, totalAmount: totalAmount });
    } catch (err) {
        console.error("Billing Transaction Error:", err);
        if (transConnection && isTransactionStarted) { try { await transConnection.rollback(); console.log("Rollback successful."); } catch (rollErr) { console.error("Rollback failed:", rollErr); } }
        res.status(500).json({ success: false, message: `Transaction failed: ${err.message}` });
    } finally {
        if (transConnection) { try { await transConnection.close(); } catch (closeErr) { console.error("Failed to close TX conn:", closeErr); } }
    }
});

// Medicines Endpoint (with search)
app.get("/api/medicines", async (req, res) => {
    try {
        const { search } = req.query;
        let sql = `SELECT * FROM Medicines`;
        const binds = [];
        if (search) {
            sql += ` WHERE UPPER(medicine_name) LIKE :1`;
            binds.push(`%${search.toUpperCase()}%`);
        }
        sql += ` ORDER BY medicine_name`;
        const rows = await runQuery(sql, binds);
        res.json(rows);
    } catch (err) {
         console.error("Error fetching medicines:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Suppliers Endpoint
app.get("/api/suppliers", async (req, res) => {
    try {
        const rows = await runQuery(`SELECT * FROM Suppliers ORDER BY company_name`);
        res.json(rows);
    } catch (err) {
         console.error("Error fetching suppliers:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Manufacturers Endpoint
app.get("/api/manufacturers", async (req, res) => {
    try {
        const rows = await runQuery(`SELECT * FROM Manufacture ORDER BY manufacturer_name`);
        res.json(rows);
    } catch (err) {
         console.error("Error fetching manufacturers:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Manufacturer Details Endpoint (with phones)
app.get("/api/manufacturer-details/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const sql = `
            SELECT m.MANUFACTURER_ID, m.MANUFACTURER_NAME, m.EMAIL, m.LICENCE_NO, m.ADDRESS, mp.PHONE_NUMBER, mp.PHONE_TYPE
            FROM Manufacture m LEFT JOIN Manufacturers_Phone mp ON m.manufacturer_id = mp.manufacturer_id
            WHERE m.manufacturer_id = :1 `;
        const rows = await runQuery(sql, [id]);
        if (rows.length === 0) { return res.status(404).json({ success: false, message: "Manufacturer not found." }); }
        const manufacturer = { ...rows[0], PHONES: [] }; // Copy base details
        delete manufacturer.PHONE_NUMBER; // Remove duplicate fields
        delete manufacturer.PHONE_TYPE;
        rows.forEach(row => { if (row.PHONE_NUMBER) { manufacturer.PHONES.push({ NUMBER: row.PHONE_NUMBER, TYPE: row.PHONE_TYPE }); } });
        res.json(manufacturer);
    } catch (err) {
        console.error(`Error fetching manufacturer ${req.params.id}:`, err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Employee Endpoints (CRUD + Phones)
app.get("/api/employees", async (req, res) => {
    try {
        const sql = `
            SELECT e.*, ph_m.phone_number AS MOBILE_PHONE, ph_w.phone_number AS WORK_PHONE
            FROM Employees e
            LEFT JOIN Employees_Phone ph_m ON e.employee_id = ph_m.employee_id AND ph_m.phone_type = 'Mobile'
            LEFT JOIN Employees_Phone ph_w ON e.employee_id = ph_w.employee_id AND ph_w.phone_type = 'Work'
            ORDER BY e.first_name `;
        const rows = await runQuery(sql);
        res.json(rows);
    } catch (err) { console.error("Error fetching employees:", err); res.status(500).json({ success: false, message: err.message }); }
});
app.post("/api/employees", async (req, res) => {
    let connection;
    try {
        const { first_name, last_name, job_title, email, address, date_of_joining, mobile_phone, work_phone } = req.body;
        const employee_id = 'E' + Date.now();
        connection = await oracledb.getConnection();
        const empSql = `INSERT INTO Employees (employee_id, first_name, last_name, job_title, email, address, date_of_joining) VALUES (:1, :2, :3, :4, :5, :6, TO_DATE(:7, 'YYYY-MM-DD'))`;
        await connection.execute(empSql, [ employee_id, first_name, last_name, job_title, email, address, date_of_joining ]);
        if (mobile_phone) { const phoneSql = `INSERT INTO Employees_Phone (employee_id, phone_number, phone_type) VALUES (:1, :2, 'Mobile')`; await connection.execute(phoneSql, [employee_id, mobile_phone]); }
        if (work_phone) { const phoneSql = `INSERT INTO Employees_Phone (employee_id, phone_number, phone_type) VALUES (:1, :2, 'Work')`; await connection.execute(phoneSql, [employee_id, work_phone]); }
        await connection.commit();
        res.status(201).json({ success: true, employee_id });
    } catch (err) {
        console.error("Error creating employee:", err); if (connection) { try { await connection.rollback(); } catch (rollErr) { console.error("Rollback failed:", rollErr); } }
        res.status(500).json({ success: false, message: err.message });
    } finally { if (connection) { try { await connection.close(); } catch (closeErr) { console.error("Error closing conn:", closeErr); } } }
});
app.put("/api/employees/:id", async (req, res) => {
    let connection;
    try {
        const { id } = req.params;
        const { first_name, last_name, job_title, email, address, date_of_joining, mobile_phone, work_phone } = req.body;
        connection = await oracledb.getConnection();
        const empSql = `UPDATE Employees SET first_name=:1, last_name=:2, job_title=:3, email=:4, address=:5, date_of_joining=TO_DATE(:6, 'YYYY-MM-DD') WHERE employee_id=:7`;
        const empResult = await connection.execute(empSql, [ first_name, last_name, job_title, email, address, date_of_joining, id ]);
        if (empResult.rowsAffected === 0) { return res.status(404).json({ success: false, message: "Employee not found." }); }
        const deletePhoneSql = `DELETE FROM Employees_Phone WHERE employee_id = :1`;
        await connection.execute(deletePhoneSql, [id]);
        if (mobile_phone) { const phoneSql = `INSERT INTO Employees_Phone (employee_id, phone_number, phone_type) VALUES (:1, :2, 'Mobile')`; await connection.execute(phoneSql, [id, mobile_phone]); }
        if (work_phone) { const phoneSql = `INSERT INTO Employees_Phone (employee_id, phone_number, phone_type) VALUES (:1, :2, 'Work')`; await connection.execute(phoneSql, [id, work_phone]); }
        await connection.commit();
        res.json({ success: true, rowsAffected: empResult.rowsAffected });
    } catch (err) {
        console.error(`Error updating employee ${req.params.id}:`, err); if (connection) { try { await connection.rollback(); } catch (rollErr) { console.error("Rollback failed:", rollErr); } }
        res.status(500).json({ success: false, message: err.message });
    } finally { if (connection) { try { await connection.close(); } catch (closeErr) { console.error("Error closing conn:", closeErr); } } }
});
app.delete("/api/employees/:id", async (req, res) => {
    try {
        const { id } = req.params; const sql = `DELETE FROM Employees WHERE employee_id = :1`;
        const rowsAffected = await runDMLQuery(sql, [id]); // ON DELETE CASCADE handles phones
        if (rowsAffected === 0) { return res.status(404).json({ success: false, message: "Employee not found." }); }
        res.json({ success: true, rowsAffected });
    } catch (err) { console.error(`Error deleting employee ${req.params.id}:`, err); res.status(500).json({ success: false, message: err.message }); }
});

// Transactions Endpoint
app.get("/api/transactions", async (req, res) => {
  try {
    const sql = ` SELECT t.*, e.first_name as employee_fname, e.last_name as employee_lname, b.customer_fname, b.customer_lname, b.customer_phone FROM Transactions t LEFT JOIN Employees e ON t.employee_id = e.employee_id LEFT JOIN Billing b ON t.transaction_id = b.transaction_id ORDER BY t.transaction_date DESC `;
    const rows = await runQuery(sql);
    const formattedRows = rows.map(tx => ({ ...tx, EMPLOYEE_NAME: `${tx.EMPLOYEE_FNAME || ''} ${tx.EMPLOYEE_LNAME || ''}`.trim() || 'Unknown', CUSTOMER_NAME: `${tx.CUSTOMER_FNAME || ''} ${tx.CUSTOMER_LNAME || ''}`.trim() || 'N/A', CUSTOMER_PHONE: tx.CUSTOMER_PHONE || 'N/A' }));
    res.json(formattedRows);
  } catch (err) { console.error("Error fetching transactions:", err); res.status(500).json({ success: false, message: err.message }); }
});

// Transaction Items Endpoint
app.get("/api/transaction-items/:id", async (req, res) => {
    try {
        const { id } = req.params; const sql = ` SELECT ti.qty_sold, ti.unit_price_at_sale, m.medicine_name FROM Transaction_Item ti JOIN Inventory i ON ti.inventory_id = i.inventory_id JOIN Medicines m ON i.medicine_id = m.medicine_id WHERE ti.transaction_id = :1 `;
        const rows = await runQuery(sql, [id]); res.json(rows);
    } catch (err) { console.error(`Error fetching TX items for ${req.params.id}:`, err); res.status(500).json({ success: false, message: err.message }); }
});

// --- Start Server ---
async function startServer() {
  try { await oracledb.createPool({...dbConfig, poolMin: 0, poolMax: 4, poolIncrement: 1 }); console.log("Connection pool created!"); app.listen(PORT, () => { console.log(`Backend server running on http://localhost:${PORT}`); }); }
  catch (err) { console.error(">>> FATAL ERROR starting server:", err); process.exit(1); }
}
// --- Graceful Shutdown ---
async function shutdown(signal) { console.log(`Received ${signal}. Shutting down...`); try { const pool = oracledb.getPool(); if (pool && pool.status === oracledb.POOL_STATUS_OPEN) { await pool.close(10); console.log("Pool closed."); } else { console.log("Pool not open."); } process.exit(0); } catch (err) { console.error("Shutdown error:", err); process.exit(1); } }
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
startServer();