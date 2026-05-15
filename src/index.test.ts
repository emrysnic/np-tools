import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collectMessages, runExport, type ExporterConfig } from "./index"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("np-tools exporter", () => {
  test("downloads messages, comments, and events into jsonl files", async () => {
    const calls: Array<{ url: string; body: string }> = []
    const outDir = await mkdtemp(path.join(os.tmpdir(), "np-tools-test-"))
    const config: ExporterConfig = {
      baseUrl: "https://np4.ironhelmet.com",
      user: "alice@example.com",
      passwd: "secret",
      gameId: "12345",
      outputDir: outDir,
      pageSize: 20,
    }

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = String(init?.body ?? "")
      calls.push({ url, body })
      const pathname = new URL(url).pathname

      if (pathname === "/account_api/login") {
        return new Response(JSON.stringify([
          "meta:login_success",
          { ok: true },
        ]), {
          status: 200,
          headers: { "set-cookie": "np_session=abc123; Path=/; HttpOnly" },
        })
      }

      if (pathname === "/account_api/init_player") {
        return new Response(JSON.stringify([
          "meta:init_player",
          { player: { uid: 9 } },
        ]), { status: 200 })
      }

      if (pathname === "/game_api/fetch_game_messages") {
        const params = new URLSearchParams(body)
        const group = params.get("group")
        if (group === "game_diplomacy") {
          return new Response(JSON.stringify([
            "message:new_messages",
            {
              group,
              messages: [
                {
                  key: "d1",
                  group,
                  status: "unread",
                  created: 1000,
                  payload: { tick: 12, body: "Hello", created: 1000 },
                },
              ],
            },
          ]), { status: 200 })
        }
        if (group === "game_event") {
          return new Response(JSON.stringify([
            "message:new_messages",
            {
              group,
              messages: [
                {
                  key: "e1",
                  group,
                  status: "read",
                  created: 1001,
                  payload: { tick: 5, body: "First event", created: 1001 },
                },
                {
                  key: "e2",
                  group,
                  status: "read",
                  created: 1002,
                  payload: { tick: 9, body: "Second event", created: 1002 },
                },
              ],
            },
          ]), { status: 200 })
        }
        throw new Error(`Unexpected group ${group}`)
      }

      if (pathname === "/game_api/fetch_game_message_comments") {
        const params = new URLSearchParams(body)
        const key = params.get("key")
        return new Response(JSON.stringify([
          "message:new_comments",
          {
            message_key: key,
            messages: [
              {
                key: `${key}-c1`,
                payload: { senderUid: 9, body: "reply one" },
              },
              {
                key: `${key}-c2`,
                payload: { senderUid: 10, body: "reply two" },
              },
            ],
          },
        ]), { status: 200 })
      }

      throw new Error(`Unexpected request ${pathname}`)
    }) as typeof fetch

    const result = await runExport(config)

    const messages = await readFile(result.messagesPath, "utf8")
    const events = await readFile(result.eventsPath, "utf8")

    expect(messages.trim().split("\n")).toHaveLength(1)
    expect(events.trim().split("\n")).toHaveLength(2)

    const messageRow = JSON.parse(messages.trim().split("\n")[0])
    expect(messageRow.key).toBe("d1")
    expect(messageRow.comments).toHaveLength(2)
    expect(messageRow.comments[0].body).toBe("reply one")

    const eventRows = events.trim().split("\n").map((line) => JSON.parse(line))
    expect(eventRows.map((row) => row.key)).toEqual(["e2", "e1"])

    expect(calls.map((call) => call.url.replace(config.baseUrl, ""))).toEqual([
      "/account_api/login",
      "/account_api/init_player",
      "/game_api/fetch_game_messages",
      "/game_api/fetch_game_message_comments",
      "/game_api/fetch_game_messages",
    ])

    await rm(outDir, { recursive: true, force: true })
  })

  test("paginates until a short page is returned", async () => {
    const config: ExporterConfig = {
      baseUrl: "https://np4.ironhelmet.com",
      user: "alice@example.com",
      passwd: "secret",
      gameId: "12345",
      outputDir: await mkdtemp(path.join(os.tmpdir(), "np-tools-test-")),
      pageSize: 2,
    }

    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const pathname = new URL(url).pathname
      calls.push(pathname)
      if (pathname === "/account_api/login") {
        return new Response(JSON.stringify(["meta:login_success", {}]), { status: 200, headers: { "set-cookie": "np_session=abc" } })
      }
      if (pathname === "/account_api/init_player") {
        return new Response(JSON.stringify(["meta:init_player", {}]), { status: 200 })
      }
      if (pathname === "/game_api/fetch_game_messages") {
        const params = new URLSearchParams(String(init?.body ?? ""))
        const offset = Number(params.get("offset") ?? "0")
        const group = params.get("group")
        if (group === "game_diplomacy" && offset === 0) {
          return new Response(JSON.stringify(["message:new_messages", { group, messages: [{ key: "d1", group, created: 1, payload: { tick: 1 } }, { key: "d2", group, created: 2, payload: { tick: 2 } }] }]), { status: 200 })
        }
        if (group === "game_diplomacy" && offset === 2) {
          return new Response(JSON.stringify(["message:new_messages", { group, messages: [{ key: "d3", group, created: 3, payload: { tick: 3 } }] }]), { status: 200 })
        }
        if (group === "game_event") {
          return new Response(JSON.stringify(["message:new_messages", { group, messages: [] }]), { status: 200 })
        }
      }
      if (pathname === "/game_api/fetch_game_message_comments") {
        return new Response(JSON.stringify(["message:new_comments", { messages: [] }]), { status: 200 })
      }
      throw new Error(`Unexpected request ${pathname}`)
    }) as typeof fetch

    const rows = await collectMessages(config, "np_session=abc", "game_diplomacy", true)
    expect(rows.map((row) => row.key)).toEqual(["d1", "d2", "d3"])
    expect(calls.filter((pathname) => pathname === "/game_api/fetch_game_messages")).toHaveLength(2)
  })
})
