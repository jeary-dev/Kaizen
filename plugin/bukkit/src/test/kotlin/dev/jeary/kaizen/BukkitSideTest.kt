package dev.jeary.kaizen

import dev.jeary.kaizen.config.ConfigException
import dev.jeary.kaizen.config.ConfigReader
import dev.jeary.kaizen.config.Messages
import dev.jeary.kaizen.config.Settings
import net.kyori.adventure.text.minimessage.MiniMessage
import net.kyori.adventure.text.minimessage.tag.resolver.Placeholder
import net.kyori.adventure.text.minimessage.tag.resolver.TagResolver
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer
import org.bukkit.configuration.file.YamlConfiguration
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.InputStreamReader
import java.time.Duration
import java.time.Instant

class BukkitSideTest {
    private fun resource(name: String): YamlConfiguration {
        val stream = checkNotNull(javaClass.classLoader.getResourceAsStream(name)) { "missing $name" }
        return InputStreamReader(stream, Charsets.UTF_8).use { YamlConfiguration.loadConfiguration(it) }
    }

    private fun yaml(text: String) = YamlConfiguration().apply { loadFromString(text) }

    @Test
    fun `the bundled config loads cleanly with the documented defaults`() {
        val s = Settings.load(resource("config.yml"))
        assertEquals("https://edit.jeary.dev", s.webUrl)
        assertEquals(Duration.ofHours(1), s.sessionTtl)
        assertEquals(512L * 1024, s.filePolicy.maxFileBytes)
        assertEquals("essentials reload", s.reloadCommands["Essentials"])
        assertTrue(s.filePolicy.isExcluded("plugins/Kaizen/data/owner.secret.txt"))
        assertTrue(s.filePolicy.isExcluded("plugins/spark/tmp/about.txt"))
        assertTrue(s.redaction.isSecretKey("rcon.password"))
    }

    @Test
    fun `every problem is reported with its file and path`() {
        val e = assertThrows<ConfigException> {
            Settings.load(
                yaml(
                    """
                    web-url: "http://edit.example.com"
                    session:
                      expire-after: forever
                    files:
                      max-files: 0
                      exclude: ["/abs/**"]
                      server-files: ["../etc/passwd.yml"]
                    redaction:
                      extra-key-patterns: ["(unclosed"]
                    reload-commands:
                      Foo: ""
                    """.trimIndent(),
                ),
            )
        }
        val paths = e.errors.map { it.path }
        assertEquals(
            listOf("web-url", "session.expire-after", "files.server-files[0]", "files.exclude[0]", "files.max-files", "redaction", "reload-commands.Foo"),
            paths,
            e.errors.joinToString("\n"),
        )
        assertTrue(e.errors.all { it.file == "config.yml" })
        assertTrue(e.errors.first().message.contains("https://"))
    }

    @Test
    fun `web url rules`() {
        assertNull(Settings.validateWebUrl("https://edit.jeary.dev"))
        assertNull(Settings.validateWebUrl("http://localhost:3100"))
        assertNull(Settings.validateWebUrl("http://127.0.0.1:3100"))
        assertNotNull(Settings.validateWebUrl("http://edit.jeary.dev"))
        assertNotNull(Settings.validateWebUrl("ftp://x"))
        assertNotNull(Settings.validateWebUrl("https://user:pw@x"))
        assertNotNull(Settings.validateWebUrl("not a url"))
    }

    @Test
    fun `durations`() {
        assertEquals(Duration.ofMinutes(90), ConfigReader.parseDuration("1h30m"))
        assertEquals(Duration.ofSeconds(45), ConfigReader.parseDuration("45"))
        assertEquals(Duration.ofDays(7), ConfigReader.parseDuration("7d"))
        assertNull(ConfigReader.parseDuration("1 week"))
        assertNull(ConfigReader.parseDuration(""))
    }

    @Test
    fun `every bundled message is valid MiniMessage and renders its placeholders`() {
        val defaults = Messages.defaults()
        assertTrue(defaults.size > 40)
        val mm = MiniMessage.miniMessage()
        val tags = TagResolver.resolver(
            listOf("prefix", "link", "token", "command", "backup", "id").map { Placeholder.parsed(it, "x") } +
                listOf("scope", "minutes", "files", "secrets", "count", "list", "reason", "added", "removed", "path", "key", "plugin", "when", "kind", "actor", "syntax")
                    .map { Placeholder.unparsed(it, "v") },
        )
        for ((key, value) in defaults) {
            val plain = PlainTextComponentSerializer.plainText().serialize(mm.deserialize(value, tags))
            assertFalse(plain.contains('<') && plain.contains('>'), "$key left an unparsed tag: $plain")
        }
        // An admin's file with a typo in a key is reported, not silently ignored.
        val e = assertThrows<ConfigException> { Messages.load(yaml("editor:\n  redy: hi\n"), defaults) }
        assertEquals("editor.redy", e.errors.single().path)
    }

    @Test
    fun `plugin yml is valid and pins exact library versions`() {
        val plugin = resource("plugin.yml")
        assertEquals("Kaizen", plugin.getString("name"))
        assertTrue(plugin.getString("description")?.contains("server's") == true)
        val libraries = plugin.getStringList("libraries")
        assertEquals(4, libraries.size)
        for (lib in libraries) assertTrue(Regex("^[\\w.-]+:[\\w.-]+:\\d+(\\.\\d+)+$").matches(lib), "not pinned: $lib")
        assertEquals("op", plugin.getString("permissions.kaizen.use.default"))
    }

    @Test
    fun `confirmation tokens belong to one sender, work once and expire`() {
        val c = Confirmations(Duration.ofMinutes(2))
        val now = Instant.parse("2026-11-18T13:00:00Z")
        val token = c.put("alice", "plan", now)
        assertNull(c.take<String>("bob", token, now))
        assertEquals("plan", c.take<String>("alice", token, now))
        assertNull(c.take<String>("alice", token, now))

        val late = c.put("alice", "plan2", now)
        assertNull(c.take<String>("alice", late, now.plusSeconds(121)))

        val first = c.put("alice", "a", now)
        val second = c.put("alice", "b", now)
        assertNull(c.take<String>("alice", first, now), "a new prompt replaces the old one")
        assertEquals("b", c.take<String>("alice", second, now))
    }
}
