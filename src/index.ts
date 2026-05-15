import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

export interface ExporterConfig {
  baseUrl: string
  user: string
  passwd: string
  gameId: string
  outputDir: string
  pageSize: number
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type ServerResponse = [string, any]

const DEFAULT_CONFIG: ExporterConfig = {
  baseUrl: (process.env.NP_BASE_URL ?? "https://np4.ironhelmet.com").replace(/\/+$/, ""),
  user: process.env.NP_USER ?? "",
  passwd: process.env.NP_PASSWD ?? "",
  gameId: process.argv[2] ?? process.env.NP_GAME_ID ?? "",
  outputDir: process.env.NP_OUTPUT_DIR ?? process.cwd(),
  pageSize: Number(process.env.NP_PAGE_SIZE ?? "20"),
}

if (import.meta.main) {
  actionMain().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}

export async function actionMain() {
  await runExport(DEFAULT_CONFIG)
}

export async function runExport(config: ExporterConfig) {
  validateConfig(config)

  const userPart = sanitizePathPart(config.user)
  const gamePart = sanitizePathPart(config.gameId)
  await mkdir(config.outputDir, { recursive: true })

  const cookie = await login(config)
  await initPlayer(config, cookie)

  const diplomacy = await collectMessages(config, cookie, "game_diplomacy", true)
  const events = await collectMessages(config, cookie, "game_event", false)

  const messagesPath = path.join(config.outputDir, `${userPart}.${gamePart}.messages.jsonl`)
  const eventsPath = path.join(config.outputDir, `${userPart}.${gamePart}.events.jsonl`)

  await writeJsonl(messagesPath, diplomacy)
  await writeJsonl(eventsPath, events)

  return { messagesPath, eventsPath, diplomacy, events }
}

export async function login(config: ExporterConfig): Promise<string> {
  const response = await postForm(config, "/account_api/login", {
    alias: config.user,
    password: config.passwd,
  })

  const [event, report] = response
  if (event !== "meta:login_success") {
    const message = extractErrorMessage(report) ?? JSON.stringify(response)
    throw new Error(`Login failed: ${message}`)
  }

  const cookie = cookieFromHeaders(report.__setCookieHeader)
  if (!cookie) {
    throw new Error("Login succeeded but no session cookie was returned")
  }
  return cookie
}

export async function initPlayer(config: ExporterConfig, cookie: string) {
  const response = await postForm(config, "/account_api/init_player", {}, cookie)
  const [event, report] = response
  if (event !== "meta:init_player") {
    throw new Error(`Unexpected init_player response: ${JSON.stringify([event, report])}`)
  }
  return report
}

export async function collectMessages(
  config: ExporterConfig,
  cookie: string,
  group: "game_diplomacy" | "game_event",
  includeComments: boolean,
) {
  const rows: any[] = []
  let offset = 0

  while (true) {
    const response = await postForm(config, "/game_api/fetch_game_messages", {
      type: "fetch_game_messages",
      group,
      count: String(config.pageSize),
      offset: String(offset),
      gameId: config.gameId,
      version: "np4",
    }, cookie)

    const [event, report] = response
    if (event !== "message:new_messages") {
      throw new Error(`Unexpected fetch_game_messages response for ${group}: ${JSON.stringify([event, report])}`)
    }

    const messages = extractMessageArray(report)
    for (const message of messages) {
      if (includeComments) {
        message.comments = await fetchComments(config, cookie, message.key)
      }
      normalizeMessage(message)
      rows.push(message)
    }

    if (messages.length < config.pageSize) {
      break
    }
    offset += config.pageSize
  }

  if (group === "game_event") {
    rows.sort((a, b) => (b?.payload?.tick ?? 0) - (a?.payload?.tick ?? 0))
  }

  return rows
}

export async function fetchComments(config: ExporterConfig, cookie: string, key: string) {
  const response = await postForm(config, "/game_api/fetch_game_message_comments", {
    type: "fetch_game_message_comments",
    key,
    count: String(config.pageSize),
    offset: "0",
    gameId: config.gameId,
    version: "np4",
  }, cookie)

  const [event, report] = response
  if (event !== "message:new_comments") {
    throw new Error(`Unexpected fetch_game_message_comments response: ${JSON.stringify([event, report])}`)
  }
  return extractMessageArray(report).map(normalizeComment)
}

function normalizeMessage(message: any) {
  if (!message || typeof message !== "object") return message
  if (message.payload && typeof message.payload === "object") {
    if (message.payload.body !== undefined && message.body === undefined) {
      message.body = message.payload.body
    }
  }
  return message
}

function normalizeComment(comment: any) {
  if (!comment || typeof comment !== "object") return comment
  if (comment.payload && typeof comment.payload === "object") {
    if (comment.payload.senderUid !== undefined && comment.player_uid === undefined) {
      comment.player_uid = comment.payload.senderUid
    }
    if (comment.payload.body !== undefined && comment.body === undefined) {
      comment.body = comment.payload.body
    }
  }
  return comment
}

export async function postForm(
  config: ExporterConfig,
  pathname: string,
  data: Record<string, string>,
  cookie?: string,
): Promise<ServerResponse> {
  const body = new URLSearchParams(data)
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json, text/plain, */*",
    "User-Agent": "np-tools/1.0",
  }
  if (cookie) {
    headers.Cookie = cookie
  }

  const response = await fetch(`${config.baseUrl}${pathname}`, {
    method: "POST",
    headers,
    body,
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${pathname}: ${text.slice(0, 500)}`)
  }

  const parsed = safeJsonParse(text)
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error(`Unexpected response from ${pathname}: ${text.slice(0, 500)}`)
  }

  const setCookieHeader = extractSetCookie(response)
  const [event, report] = parsed as ServerResponse
  if (report && typeof report === "object" && setCookieHeader) {
    Object.defineProperty(report, "__setCookieHeader", {
      value: setCookieHeader,
      enumerable: false,
      configurable: true,
    })
  }
  return [event, report]
}

function validateConfig(config: ExporterConfig) {
  if (!config.user || !config.passwd || !config.gameId) {
    throw new Error("Usage: NP_USER=... NP_PASSWD=... GAME_ID=... bun run src/index.ts")
  }
}

function extractSetCookie(response: Response): string {
  const getSetCookie = (response.headers as any).getSetCookie
  let cookies: string[] = []
  if (typeof getSetCookie === "function") {
    cookies = getSetCookie.call(response.headers)
  } else {
    const single = response.headers.get("set-cookie")
    if (single) cookies = [single]
  }
  return cookies
    .map((cookie) => cookie.split(";")[0].trim())
    .filter(Boolean)
    .join("; ")
}

function cookieFromHeaders(cookieHeader?: string): string {
  return cookieHeader ?? ""
}

function extractErrorMessage(report: any): string | undefined {
  if (!report || typeof report !== "object") return undefined
  return report.message ?? report.error ?? report.reason ?? report.note
}

function extractMessageArray(report: any): any[] {
  if (!report || typeof report !== "object") return []
  if (Array.isArray(report.messages)) return report.messages
  if (report.data && typeof report.data === "object" && Array.isArray(report.data.messages)) {
    return report.data.messages
  }
  if (Array.isArray(report.items)) return report.items
  return []
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_")
}

async function writeJsonl(filePath: string, rows: unknown[]) {
  const content = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "")
  await writeFile(filePath, content, "utf8")
}
