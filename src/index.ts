import { createBot, registerCommands } from "./bot";
import { config } from "./config";
import { CbrKeyRateService } from "./integrations/cbr-key-rate";
import { IceCocoaHoursService } from "./integrations/ice-cocoa-hours";
import { MoexIssService } from "./integrations/moex-iss";
import { TBankInvestService } from "./integrations/tbank-invest";
import { TradingViewService } from "./integrations/tradingview";
import { CocoaReportService } from "./services/cocoa-report";

async function main(): Promise<void> {
  const iceCocoaHoursService = new IceCocoaHoursService(config);
  const tradingViewService = new TradingViewService(config, iceCocoaHoursService);
  const moexIssService = new MoexIssService(config);
  const tbankInvestService = new TBankInvestService(config);
  const cbrKeyRateService = new CbrKeyRateService(config);
  const reportService = new CocoaReportService(
    tradingViewService,
    moexIssService,
    tbankInvestService,
    cbrKeyRateService,
    iceCocoaHoursService,
    config
  );
  const bot = createBot(config, reportService);

  await bot.init();
  await registerCommands(bot);

  console.log("Telegram bot is starting...");

  const stop = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, stopping bot...`);
    await bot.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void stop("SIGINT");
  });

  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });

  await bot.start({
    onStart: (botInfo) => {
      console.log(`Bot @${botInfo.username} started.`);
    }
  });
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
