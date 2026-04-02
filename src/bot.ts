import { Bot, type Context } from "grammy";

import type { AppConfig } from "./config";
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
      localSymbolOverride: parsedArgs.localSymbolOverride
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
    ``,
    `Без аргументов бот сам выбирает ближайший неистекший контракт на какао по MOEX.`,
    `Если указать тикер, например CCJ6, бот посчитает отчет по этому контракту.`
  ].join("\n");
}

function parseCocoaArgs(
  args: string[]
): { localSymbolOverride?: string } | null {
  const [firstArg, secondArg] = args;

  if (!firstArg) {
    return {};
  }

  if (secondArg) {
    return null;
  }

  if (isAutoKeyword(firstArg)) {
    return {};
  }

  if (looksLikeNumber(firstArg)) {
    return null;
  }

  return {
    localSymbolOverride: firstArg
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

function formatClock(value: { toFormat: (format: string) => string }): string {
  return value.toFormat("HH:mm");
}
