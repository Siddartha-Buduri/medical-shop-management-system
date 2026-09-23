const oracledb = require("oracledb");
try { oracledb.initOracleClient({ libDir: "C:\\oracleclient\\instantclient_11_2" }); } catch (err) { console.error(err); process.exit(1); }

const express = require("express");
const cors = require("cors");
const dbConfig = require("./db-config.js"); 

const app = express();
app.use(cors());
app.use(express.json());

async function runQuery(sql, binds = []) {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const result = await connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return result.rows;
  } finally { if (connection) await connection.close(); }
}

// Sprint 1 Endpoints: Just reading the foundational data
app.get("/api/inventory", async (req, res) => {
  try {
    const sql = `SELECT i.inventory_id, i.batch_number, i.quantity, i.expiry_date, m.medicine_id, m.medicine_name, m.unit_price FROM Inventory i JOIN Medicines m ON i.medicine_id = m.medicine_id WHERE i.quantity > 0`;
    res.json(await runQuery(sql));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/medicines", async (req, res) => {
  try { res.json(await runQuery(`SELECT * FROM Medicines ORDER BY medicine_name`)); } 
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

async function startServer() {
  await oracledb.createPool({...dbConfig, poolMin: 0, poolMax: 4 });
  app.listen(3000, () => console.log("Sprint 1 Backend running on port 3000"));
}
startServer();
