import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const BASE_URL = (process.env.NP_BASE_URL ?? "https://np4.ironhelmet.com").replace(/\/+$/, "")
const NP_USER = process.env.NP_USER ?? ""
const NP_PASSWD = process.env.NP_PASSWD ?? ""
const GAME_ID = process.argv[2] ?? process.env.NP_GAME_ID ?? ""
const OUTPUT_DIR = process.env.NP_OUTPUT_DIR ?? process.cwd()
const PAGE_SIZE = Number(process.env.NP_PAGE_SIZE ?? "20")
const VERSION = "np4"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type ServerResponse = [string, any]

actionMain().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})

async function actionMain() {
  if (!NP_USER || !NP_PASSWD || !GAME_ID) {
    throw new Error("Usage: NP_USER=... NP_PASSWD=... GAME_ID=... bun run src/index.ts")
  }

  const userPart = sanitizePathPart(NP_USER)
  const gamePart = sanitizePathPart(GAME_ID)
  await mkdir(OUTPUT_DIR, { recursive: true })

  const cookie = await login()
  await initPlayer(cookie)

  const diplomacy = await collectMessages(cookie, "game_diplomacy", true)
  const events = await collectMessages(cookie, "game_event", false)

  const messagesPath = path.join(OUTPUT_DIR, `${userPart}.${gamePart}.messages.jsonl`)
  const eventsPath = path.join(OUTPUT_DIR, `${userPart}.${gamePart}.events.jsonl`)

  await writeJsonl(messagesPath, diplomacy)
  await writeJsonl(eventsPath, events)

  console.log(JSON.stringify({ messages: messagesPath, events: eventsPath, diplomacy: diplomacy.length, eventsCount: events.length }, null, 2))
}

async function login(): Promise<string> {
  const response = await postForm("/account_api/login", {
    alias: NP_USER,
    password: NP_PASSWD,
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

async function initPlayer(cookie: string) {
  const response = await postForm("/account_api/init_player", {}, cookie)
  const [event, report] = response
  if (event !== "meta:init_player") {
    throw new Error(`Unexpected init_player response: ${JSON.stringify([event, report])}`)
  }
  return report
}

async function collectMessages(cookie: string, group: "game_diplomacy" | "game_event", includeComments: boolean) {
  const rows: any[] = []
  let offset = 0

  while (true) {
    const response = await postForm("/game_api/fetch_game_messages", {
      type: "fetch_game_messages",
      group,
      count: String(PAGE_SIZE),
      offset: String(offset),
      gameId: GAME_ID,
      version: VERSION,
    }, cookie)

    const [event, report] = response
    if (event !== "messages:new_messages") {
      throw new Error(`Unexpected fetch_game_messages response for ${group}: ${JSON.stringify([event, report])}`)
    }

    const messages = Array.isArray(report?.messages) ? report.messages : []
    for (const message of messages) {
      if (includeComments) {
        message.comments = await fetchComments(cookie, message.key)
      }
      rows.push(message)
    }

    if (messages.length < PAGE_SIZE) {
      break
    }
    offset += PAGE_SIZE
  }

  return rows
}

async function fetchComments(cookie: string, key: string) {
  const response = await postForm("/game_api/fetch_game_message_comments", {
    type: "fetch_game_message_comments",
    key,
    count: String(PAGE_SIZE),
    offset: "0",
    gameId: GAME_ID,
    version: VERSION,
  }, cookie)

  const [event, report] = response
  if (event !== "message:new_comments") {
    throw new Error(`Unexpected fetch_game_message_comments response: ${JSON.stringify([event, report])}`)
  }
  return Array.isArray(report?.messages) ? report.messages : []
}

async function postForm(pathname: string, data: Record<string, string>, cookie?: string): Promise<ServerResponse> {
  const body = new URLSearchParams(data)
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "np-tools/1.0",
  }
  if (cookie) {
    headers.Cookie = cookie
  }

  const response = await fetch(`${BASE_URL}${pathname}`, {
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
