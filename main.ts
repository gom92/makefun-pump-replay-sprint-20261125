// Dawn Dip Reversion — entrypoint for the make.fun pump.fun replay sprint.
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at /bot.
// The strategy lives in strategy.ts; this file only wires it to the harness shim.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

await runBot(createBot());
