import { yardiParser } from './yardi';
import { appfolioParser } from './appfolio';
import { onesiteParser } from './onesite';
import { firstserviceParser } from './firstservice';
import { quickbooksParser } from './quickbooks';
import { vantacaParser } from './vantaca';
import { customParser } from './custom';
export const parserRegistry = [yardiParser, appfolioParser, onesiteParser, firstserviceParser, quickbooksParser, vantacaParser, customParser] as const;
