import { Bot, type Context } from "grammy";

import type { AppConfig } from "./config";
import { normalizeTradingViewCocoaSymbol } from "./domain/ice-cocoa-symbol";
import {
  ForeignMarketOpenError,
  type CocoaReportService
} from "./services/cocoa-report";
import { formatCocoaReport } from "./utils/format";

interface ParsedCommand {
  name: string;
  args: string[];
}

export function createBot(
  config: AppConfig,
  reportService: CocoaReportService
): Bot {
  const bot = new Bot(config.botToken);

  bot.catch((error) => {
    console.error("Telegram bot error:", error.error);
  });

  bot.use(async (ctx, next) => {
    const text = getTextFromUpdate(ctx);
    if (!text) {
      return next();
    }

    const parsedCommand = parseCommand(text, bot.botInfo?.username);
    if (!parsedCommand) {
      return next();
    }

    if (!isChatAllowed(ctx, config)) {
      await ctx.reply("Этот чат не входит в список разрешенных для бота.");
      return;
    }

    switch (parsedCommand.name) {
      case "start":
      case "help":
        await ctx.reply(getHelpText(), { parse_mode: "HTML" });
        return;
      case "cocoa":
        await handleCocoaCommand(ctx, parsedCommand.args, reportService, config);
        return;
      default:
        return next();
    }
  });

  return bot;
}

export async function registerCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    {
      command: "cocoa",
      description: "Рассчитать отклонение российского какао"
    }
  ]);
}

async function handleCocoaCommand(
  ctx: Context,
  args: string[],
  reportService: CocoaReportService,
  config: AppConfig
): Promise<void> {
  const parsedArgs = parseCocoaArgs(args);
  if (!parsedArgs) {
    await ctx.reply(
      "Не смог разобрать команду. Используйте /cocoa или /cocoa CCJ6"
    );
    return;
  }

  try {
    const report = await reportService.buildReport({
      localSymbolOverride: parsedArgs.localSymbolOverride,
      worldSymbolOverride: parsedArgs.worldSymbolOverride
    });

    await ctx.reply(formatCocoaReport(report, config.signalThresholds), {
      parse_mode: "HTML"
    });
  } catch (error) {
    if (error instanceof ForeignMarketOpenError) {
      await ctx.reply(
        [
          "Сейчас идут торги на зарубежном рынке, поэтому расчет временно недоступен.",
          `Торговое окно: ${formatClock(error.marketOpenTime)}-${formatClock(error.marketCloseTime)} МСК.`,
          `Попробуйте снова после ${formatClock(error.marketCloseTime)} МСК.`
        ].join("\n")
      );
      return;
    }

    const message =
      error instanceof Error ? error.message : "Неизвестная ошибка.";

    await ctx.reply(`Не удалось получить расчет.\nПричина: ${message}`);
  }
}

function getTextFromUpdate(ctx: Context): string | undefined {
  if ("message" in ctx.update && ctx.update.message?.text) {
    return ctx.update.message.text;
  }

  if ("channel_post" in ctx.update && ctx.update.channel_post?.text) {
    return ctx.update.channel_post.text;
  }

  return undefined;
}

function parseCommand(text: string, botUsername?: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...args] = trimmed.split(/\s+/);
  const match = rawCommand.match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?$/);

  if (!match) {
    return null;
  }

  const commandName = match[1].toLowerCase();
  const commandBotUsername = match[2]?.toLowerCase();

  if (
    commandBotUsername &&
    botUsername &&
    commandBotUsername !== botUsername.toLowerCase()
  ) {
    return null;
  }

  return {
    name: commandName,
    args
  };
}

function isChatAllowed(ctx: Context, config: AppConfig): boolean {
  if (!config.allowedChatIds) {
    return true;
  }

  return ctx.chat?.id !== undefined && config.allowedChatIds.has(ctx.chat.id);
}

function getHelpText(): string {
  return [
    `<b>Команды</b>`,
    `/cocoa`,
    `/cocoa CCJ6`,
    `/cocoa world=ICEUS:CCK2026`,
    `/cocoa CCJ6 world=ICEUS:CCK2026`,
    ``,
    `Без аргументов бот сам выбирает ближайший неистекший контракт на какао по MOEX.`,
    `Если указать тикер, например CCJ6, бот посчитает отчет по этому контракту.`,
    `Через world=... можно вручную задать зарубежный тикер TradingView для расчета.`
  ].join("\n");
}

function parseCocoaArgs(
  args: string[]
): { localSymbolOverride?: string; worldSymbolOverride?: string } | null {
  if (args.length === 0) {
    return {};
  }

  if (args.length > 2) {
    return null;
  }

  let localSymbolOverride: string | undefined;
  let worldSymbolOverride: string | undefined;

  for (const arg of args) {
    if (isAutoKeyword(arg)) {
      continue;
    }

    if (looksLikeNumber(arg)) {
      return null;
    }

    const keyedWorldSymbol = extractWorldSymbolArg(arg);
    if (keyedWorldSymbol) {
      if (worldSymbolOverride) {
        return null;
      }

      worldSymbolOverride = keyedWorldSymbol;
      continue;
    }

    if (looksLikeTradingViewWorldSymbol(arg)) {
      if (worldSymbolOverride) {
        return null;
      }

      worldSymbolOverride = normalizeWorldSymbolInput(arg);
      continue;
    }

    if (localSymbolOverride) {
      return null;
    }

    localSymbolOverride = arg;
  }

  return {
    localSymbolOverride,
    worldSymbolOverride
  };
}

function isAutoKeyword(value: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === "auto" || normalizedValue === "current";
}

function looksLikeNumber(value: string): boolean {
  const normalizedValue = Number(value.replace(",", "."));
  return !Number.isNaN(normalizedValue);
}

function extractWorldSymbolArg(value: string): string | null {
  const match = value.match(/^(world|ice|tv)=(.+)$/i);
  if (!match) {
    return null;
  }

  const symbol = match[2]?.trim();
  if (!symbol) {
    return null;
  }

  return normalizeWorldSymbolInput(symbol);
}

function looksLikeTradingViewWorldSymbol(value: string): boolean {
  const trimmed = value.trim().toUpperCase();

  return (
    trimmed.includes(":") ||
    trimmed === "CC1!" ||
    /^CC[HKNUZ]\d{4}$/.test(trimmed)
  );
}

function normalizeWorldSymbolInput(value: string): string {
  return normalizeTradingViewCocoaSymbol(value);
}

function formatClock(value: { toFormat: (format: string) => string }): string {
  return value.toFormat("HH:mm");
}
