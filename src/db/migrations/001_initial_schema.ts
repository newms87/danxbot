import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS health_check (
      id INT AUTO_INCREMENT PRIMARY KEY,
      checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS health_check");
}
