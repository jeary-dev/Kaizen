package dev.jeary.kaizen.core.redaction

import dev.jeary.kaizen.core.protocol.Lang
import dev.jeary.kaizen.core.protocol.ProtocolException
import dev.jeary.kaizen.core.protocol.Reason
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class RedactorTest {
    private val rules = RedactionRules()
    private val tag = "q7f2"

    /** Redacts, checks the expected secrets are gone, and checks that restore gives the original back. */
    private fun check(lang: Lang, content: String, vararg secrets: String): Redacted {
        val r = Redactor.redact(content, lang, rules, tag)
        for (s in secrets) assertFalse(r.content.contains(s), "secret '$s' leaked:\n${r.content}")
        assertEquals(secrets.size, r.secrets.size, "secrets found: ${r.originals.values}\n${r.content}")
        assertEquals(secrets.toList(), r.originals.values.toList())
        assertEquals(content, Redactor.restore(r.content, tag, r.originals).content)
        // Deterministic: same input, same output.
        assertEquals(r.content, Redactor.redact(content, lang, rules, tag).content)
        return r
    }

    @Nested
    inner class Yaml {
        @Test
        fun `nested keys, quotes, comments and formatting are kept`() {
            val yaml = """
                # Database settings
                database:
                  host: localhost   # the host
                  port: 3306
                  username: "steve"
                  password: "hunter2" # keep me
                  api-key: 'abc123'
                  auth_token: plainvalue
                motd: hello
            """.trimIndent() + "\n"
            val r = check(Lang.YAML, yaml, "hunter2", "abc123", "plainvalue")
            assertTrue(r.content.contains("password: \"KAIZEN_SECRET_1_q7f2\" # keep me"))
            assertTrue(r.content.contains("api-key: 'KAIZEN_SECRET_2_q7f2'"))
            assertTrue(r.content.contains("host: localhost   # the host"))
            assertEquals(listOf("database.password", "database.api-key", "database.auth_token"), r.secrets.map { it.key })
            assertEquals(listOf(6, 7, 8), r.secrets.map { it.line })
        }

        @Test
        fun `positions survive emoji, CJK and a BOM before the secret`() {
            check(Lang.YAML, "﻿title: \"🌸 桜 🌸\"\nnested:\n  secret: s3cr3t🌸x\n", "s3cr3t🌸x")
        }

        @Test
        fun `every item of a sensitive list or map is redacted`() {
            val yaml = "tokens:\n  - aaa\n  - \"bbb\"\nwebhooks:\n  alerts: https://x.example/1\n  logs: https://x.example/2\nnormal:\n  - ccc\n"
            check(Lang.YAML, yaml, "aaa", "bbb", "https://x.example/1", "https://x.example/2")
        }

        @Test
        fun `block scalars keep their header and indentation`() {
            val yaml = "private-key: |\n  -----BEGIN KEY-----\n  abcdef\n  -----END KEY-----\nafter: 1\n"
            val r = check(Lang.YAML, yaml, "-----BEGIN KEY-----\n  abcdef\n  -----END KEY-----")
            assertEquals("private-key: |\n  KAIZEN_SECRET_1_q7f2\nafter: 1\n", r.content)
        }

        @Test
        fun `value patterns catch credentials under innocent keys`() {
            val yaml = "storage:\n  url: jdbc:mysql://db:3306/mc?user=root&password=pw\n  uri: mongodb://admin:pa55@mongo:27017\n  hook: https://discord.com/api/webhooks/123/abc\n  site: https://example.com\n"
            check(
                Lang.YAML,
                yaml,
                "jdbc:mysql://db:3306/mc?user=root&password=pw",
                "mongodb://admin:pa55@mongo:27017",
                "https://discord.com/api/webhooks/123/abc",
            )
        }

        @Test
        fun `empty and null secrets are left alone, flow style works`() {
            check(Lang.YAML, "password: ''\ntoken:\nsecret: ~\n", "~")
            check(Lang.YAML, "db: {user: a, password: flowpw}\nlist: [x, y]\n", "flowpw")
        }

        @Test
        fun `anchors, aliases and multiple documents don't confuse key tracking`() {
            val yaml = "base: &b\n  password: one\ncopy: *b\nlast:\n  token: two\n---\nsecond:\n  password: three\n"
            check(Lang.YAML, yaml, "one", "two", "three")
        }

        @Test
        fun `invalid YAML falls back to the line scanner`() {
            val yaml = "key: [unclosed\npassword: hunter2\n\tbad: tab\n"
            check(Lang.YAML, yaml, "hunter2")
        }

        @Test
        fun `CRLF line endings are preserved`() {
            check(Lang.YAML, "a: 1\r\npassword: x1\r\nb: 2\r\n", "x1")
        }
    }

    @Nested
    inner class Json {
        @Test
        fun `string values under secret keys, nested, with escapes`() {
            val json = """{
              "name": "server",
              "auth": { "token": "t-\"quoted\"-1", "user": "bob" },
              "keys": ["a", "b"],
              "apiKey": "zzz",
              "port": 25565
            }"""
            check(Lang.JSON, json, "t-\\\"quoted\\\"-1", "zzz")
        }

        @Test
        fun `numbers are not redacted (a bare placeholder would break the JSON)`() {
            check(Lang.JSON, """{"pin": 1234, "password": "x"}""", "x")
        }

        @Test
        fun `arrays under a sensitive key and comments are handled`() {
            val json = "{\n  // tokens for the bot\n  \"tokens\": [\"one\", \"two\"], /* inline */ \"ok\": true\n}"
            check(Lang.JSON, json, "one", "two")
        }

        @Test
        fun `broken JSON falls back to lines`() {
            check(Lang.JSON, "{\n  \"password\": \"pw\",\n  \"x\": \n", "pw")
        }
    }

    @Nested
    inner class Properties {
        @Test
        fun `server properties style`() {
            val props = "#Minecraft server properties\nmotd=A Minecraft Server\nrcon.password=sup3r\nmanagement-server-secret=abc\nenable-rcon=false\nlevel-seed=\n"
            val r = check(Lang.PROPERTIES, props, "sup3r", "abc")
            assertEquals(listOf("rcon.password", "management-server-secret"), r.secrets.map { it.key })
        }

        @Test
        fun `separators, continuations, escapes and CRLF`() {
            val props = "a.password : spaced value\r\nb.token=line1\\\r\n    line2\r\n! comment password=nope\r\nc.secret   tabbed\r\nescaped\\=password=x\r\n"
            // `escaped\=password` is the key "escaped=password", which also looks like a secret key.
            check(Lang.PROPERTIES, props, "spaced value", "line1\\\r\n    line2", "tabbed", "x")
        }
    }

    @Nested
    inner class Toml {
        @Test
        fun `tables, quoted keys, strings, arrays and inline tables`() {
            val toml = """
                title = "Kaizen"
                [database]
                user = "root"
                password = "p@ss"
                "api-key" = 'literal'
                port = 5432
                [bot]
                tokens = ["t1", "t2"]
                creds = { user = "u", secret = "inline-s3cret" }
                notes = ""${'"'}
                  multi
                ""${'"'}
                webhook = ""${'"'}https://hooks.slack.com/services/T/B/X""${'"'}
            """.trimIndent() + "\n"
            check(Lang.TOML, toml, "p@ss", "literal", "t1", "t2", "inline-s3cret", "https://hooks.slack.com/services/T/B/X")
        }

        @Test
        fun `non-string secrets are not redacted`() {
            check(Lang.TOML, "password = 1234\ntoken = true\n")
        }
    }

    @Nested
    inner class Hocon {
        @Test
        fun `blocks, quoted and unquoted values`() {
            val conf = """
                # Velocity-style
                database {
                  username = "mc"
                  password = "dbpass"
                  token: unquoted-token # comment
                }
                server-name = Hub
                forwarding-secret = "fwd"
            """.trimIndent() + "\n"
            val r = check(Lang.CONF, conf, "dbpass", "unquoted-token", "fwd")
            assertEquals(listOf("database.password", "database.token", "forwarding-secret"), r.secrets.map { it.key })
        }
    }

    @Test
    fun `text files only use value patterns`() {
        check(Lang.TEXT, "connect to postgres://bob:pw@db/x for stats\npassword: not-structured\n", "postgres://bob:pw@db/x")
    }

    @Nested
    inner class Restore {
        private val original = "a: 1\npassword: real\ntoken: other\n"
        private val redacted = Redactor.redact(original, Lang.YAML, rules, tag)

        @Test
        fun `edits around placeholders keep the real values`() {
            val edited = redacted.content.replace("a: 1", "a: 2") + "new: line\n"
            assertEquals("a: 2\npassword: real\ntoken: other\nnew: line\n", Redactor.restore(edited, tag, redacted.originals).content)
        }

        @Test
        fun `a placeholder can be moved but not duplicated`() {
            val moved = "token: KAIZEN_SECRET_2_q7f2\npassword: KAIZEN_SECRET_1_q7f2\n"
            assertEquals("token: other\npassword: real\n", Redactor.restore(moved, tag, redacted.originals).content)
            val dup = redacted.content + "copy: KAIZEN_SECRET_1_q7f2\n"
            val e = assertThrows<ProtocolException> { Redactor.restore(dup, tag, redacted.originals) }
            assertEquals(Reason.PLACEHOLDER, e.reason)
        }

        @Test
        fun `unknown placeholders with the session tag are rejected`() {
            val e = assertThrows<ProtocolException> {
                Redactor.restore(redacted.content + "x: KAIZEN_SECRET_9_q7f2\n", tag, redacted.originals)
            }
            assertEquals(Reason.PLACEHOLDER, e.reason)
        }

        @Test
        fun `placeholder-looking text with another tag is just text`() {
            val text = redacted.content + "doc: KAIZEN_SECRET_1_zzzz\n"
            assertTrue(Redactor.restore(text, tag, redacted.originals).content.endsWith("doc: KAIZEN_SECRET_1_zzzz\n"))
        }

        @Test
        fun `deleting a secret is reported as removed`() {
            val edited = redacted.content.replace("token: KAIZEN_SECRET_2_q7f2\n", "")
            val restored = Redactor.restore(edited, tag, redacted.originals)
            assertEquals("a: 1\npassword: real\n", restored.content)
            assertEquals(listOf("KAIZEN_SECRET_2_q7f2"), restored.removed)
        }

        @Test
        fun `replacement text containing dollar signs and backslashes is inserted literally`() {
            val r = Redactor.redact("password: a\$1\\b\n", Lang.YAML, rules, tag)
            assertEquals("password: a\$1\\b\n", Redactor.restore(r.content, tag, r.originals).content)
        }

        @Test
        fun `collision detection`() {
            assertTrue(Redactor.collides("x: KAIZEN_SECRET_3_q7f2", tag))
            assertFalse(Redactor.collides("x: KAIZEN_SECRET_3_q7f2x", tag))
        }
    }

    @Test
    fun `custom rules compile, and invalid patterns are reported`() {
        val errors = mutableListOf<String>()
        val custom = RedactionRules.compile(listOf("motd", "(broken"), emptyList()) { p, _ -> errors += p }
        assertEquals(listOf("(broken"), errors)
        val r = Redactor.redact("motd=secret message\npassword=visible\n", Lang.PROPERTIES, custom, tag)
        assertEquals(listOf("motd"), r.secrets.map { it.key })
    }
}
