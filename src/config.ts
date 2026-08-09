import path from 'node:path'
import os from 'node:os'

export type RuntimeConfig = {
  model: string
  baseUrl: string
  authToken?: string
  apiKey?: string
  maxOutputTokens?: number
 
  sourceSummary: string
}
export const ICEFOX_CODE_DIR = process.env.ICEFOX_CODE_HOME
  ? path.resolve(process.env.ICEFOX_CODE_HOME)
  : path.join(os.homedir(), '.ICEFOX-code')

