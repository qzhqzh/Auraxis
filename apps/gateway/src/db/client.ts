import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { AppConfig } from '../config.js'
import * as schema from './schema.js'

const { Pool } = pg

export function createDatabaseClient(config: Pick<AppConfig, 'databaseUrl'>) {
  const pool = new Pool({
    connectionString: config.databaseUrl
  })

  return {
    pool,
    db: drizzle(pool, { schema })
  }
}
