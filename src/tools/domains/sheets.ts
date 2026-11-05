import { SheetsService } from '../../vendored/services/SheetsService.js'
import { makeDomainRun } from './factory.js'

export const SHEETS_ACTIONS = [
  'getText',
  'getRange',
  'getMetadata',
  'updateRange',
  'appendRows',
  'clearRange',
  'create'
] as const
export const sheets = makeDomainRun(SheetsService, SHEETS_ACTIONS)
