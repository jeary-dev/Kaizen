package dev.jeary.kaizen.core.redaction

import dev.jeary.kaizen.core.protocol.Lang
import org.snakeyaml.engine.v2.api.LoadSettings
import org.snakeyaml.engine.v2.api.lowlevel.Parse
import org.snakeyaml.engine.v2.common.ScalarStyle
import org.snakeyaml.engine.v2.events.AliasEvent
import org.snakeyaml.engine.v2.events.Event
import org.snakeyaml.engine.v2.events.MappingEndEvent
import org.snakeyaml.engine.v2.events.MappingStartEvent
import org.snakeyaml.engine.v2.events.ScalarEvent
import org.snakeyaml.engine.v2.events.SequenceEndEvent
import org.snakeyaml.engine.v2.events.SequenceStartEvent
import org.snakeyaml.engine.v2.exceptions.YamlEngineException

/**
 * Format-aware scanners that find secret value spans in raw text. They never rewrite the file.
 * They only report where values are, so comments and formatting survive exactly.
 *
 * Every scanner falls back to a forgiving line scanner if the file can't be parsed. A broken
 * file on disk still gets its secrets hidden.
 */
internal object Scanners {

    fun scan(content: String, lang: Lang, rules: RedactionRules): List<SecretSpan> = when (lang) {
        Lang.YAML -> Yaml.scan(content, rules) ?: Lines.scan(content, rules)
        Lang.JSON -> Json.scan(content, rules) ?: Lines.scan(content, rules)
        Lang.PROPERTIES -> Properties.scan(content, rules)
        Lang.TOML -> Toml.scan(content, rules)
        Lang.CONF -> Hocon.scan(content, rules)
        Lang.TEXT -> valueMatches(content, rules)
    }

    /** Value patterns in free text: the whole match is the secret. */
    fun valueMatches(content: String, rules: RedactionRules): List<SecretSpan> =
        rules.valuePatterns.flatMap { p ->
            p.findAll(content).map { m ->
                // Extend to the end of the token (URL or key) the pattern started in.
                var end = m.range.last + 1
                while (end < content.length && !content[end].isWhitespace() && content[end] !in "\"'`<>,") end++
                SecretSpan(m.range.first, end, "")
            }
        }

    // --------------------------------------------------------------------------------------------
    // YAML, via snakeyaml-engine's event stream. Marks give exact positions for every scalar.

    private object Yaml {
        private sealed class Ctx(val sensitive: Boolean, val path: String) {
            class Map(sensitive: Boolean, path: String) : Ctx(sensitive, path) {
                var expectKey = true
                var key: String? = null
            }

            class Seq(sensitive: Boolean, path: String) : Ctx(sensitive, path)
        }

        fun scan(content: String, rules: RedactionRules): List<SecretSpan>? {
            val bom = content.startsWith("﻿")
            val text = if (bom) content.substring(1) else content
            val offsets = CodePointOffsets(text)
            val shift = if (bom) 1 else 0
            val spans = mutableListOf<SecretSpan>()
            val stack = ArrayDeque<Ctx>()

            fun keyPath(ctx: Ctx.Map) = listOfNotNull(ctx.path.ifEmpty { null }, ctx.key).joinToString(".")

            /** Called after a value (scalar, alias or collection) has finished in the current context. */
            fun valueDone() {
                (stack.lastOrNull() as? Ctx.Map)?.let { it.expectKey = true }
            }

            fun push(sensitiveSelf: Boolean, isMap: Boolean) {
                val parent = stack.lastOrNull()
                val (sensitive, path) = when (parent) {
                    null -> false to ""
                    is Ctx.Map -> if (parent.expectKey) {
                        parent.expectKey = false
                        parent.key = "?"
                        false to keyPath(parent)
                    } else {
                        (parent.sensitive || rules.isSecretKey(parent.key)) to keyPath(parent)
                    }
                    is Ctx.Seq -> parent.sensitive to parent.path
                }
                stack.addLast(if (isMap) Ctx.Map(sensitive || sensitiveSelf, path) else Ctx.Seq(sensitive || sensitiveSelf, path))
            }

            try {
                val settings = LoadSettings.builder().setUseMarks(true).setAllowDuplicateKeys(true).build()
                for (event: Event in Parse(settings).parseString(text)) {
                    when (event) {
                        is MappingStartEvent -> push(false, isMap = true)
                        is SequenceStartEvent -> push(false, isMap = false)
                        is MappingEndEvent, is SequenceEndEvent -> {
                            stack.removeLastOrNull()
                            valueDone()
                        }
                        is AliasEvent -> {
                            val top = stack.lastOrNull()
                            if (top is Ctx.Map && top.expectKey) {
                                top.expectKey = false
                                top.key = "*"
                            } else {
                                valueDone()
                            }
                        }
                        is ScalarEvent -> {
                            val top = stack.lastOrNull()
                            if (top is Ctx.Map && top.expectKey) {
                                top.key = event.value
                                top.expectKey = false
                                continue
                            }
                            val key = when (top) {
                                is Ctx.Map -> keyPath(top)
                                is Ctx.Seq -> top.path
                                null -> ""
                            }
                            val sensitive = when (top) {
                                is Ctx.Map -> top.sensitive || rules.isSecretKey(top.key)
                                is Ctx.Seq -> top.sensitive
                                null -> false
                            }
                            if (event.value.isNotEmpty() && (sensitive || rules.isSecretValue(event.value))) {
                                spanOf(event, text, offsets)?.let { (s, e) -> spans += SecretSpan(s + shift, e + shift, key) }
                            }
                            valueDone()
                        }
                        else -> Unit
                    }
                }
            } catch (_: YamlEngineException) {
                return null
            }
            return spans
        }

        private fun spanOf(event: ScalarEvent, text: String, offsets: CodePointOffsets): Pair<Int, Int>? {
            val start = event.startMark.orElse(null) ?: return null
            val end = event.endMark.orElse(null) ?: return null
            var s = offsets.charIndex(start.index)
            var e = offsets.charIndex(end.index)
            when (event.scalarStyle) {
                ScalarStyle.SINGLE_QUOTED, ScalarStyle.DOUBLE_QUOTED -> { s += 1; e -= 1 }
                ScalarStyle.LITERAL, ScalarStyle.FOLDED -> {
                    // Keep the `|`/`>` header line. The secret is the indented block below it.
                    val newline = text.indexOf('\n', s)
                    if (newline < 0 || newline >= e) return null
                    s = newline + 1
                    while (s < e && text[s] == ' ') s++
                    while (e > s && text[e - 1].isWhitespace()) e--
                }
                else -> Unit
            }
            return if (e > s) s to e else null
        }
    }

    /** snakeyaml-engine marks count code points; Kotlin strings index UTF-16 chars. */
    private class CodePointOffsets(private val text: String) {
        private val hasSupplementary = text.any { it.isSurrogate() }
        fun charIndex(codePointIndex: Int): Int =
            if (!hasSupplementary) codePointIndex.coerceAtMost(text.length)
            else text.offsetByCodePoints(0, codePointIndex.coerceAtMost(text.codePointCount(0, text.length)))
    }

    // --------------------------------------------------------------------------------------------
    // JSON (comments tolerated), with a position-tracking tokenizer. Only string values are
    // redacted: a bare placeholder in place of a number would make the file invalid JSON.

    private object Json {
        private class Ctx(val isObject: Boolean, val sensitive: Boolean, val path: String) {
            var expectKey = isObject
            var key: String? = null
        }

        fun scan(text: String, rules: RedactionRules): List<SecretSpan>? {
            val spans = mutableListOf<SecretSpan>()
            val stack = ArrayDeque<Ctx>()
            var i = if (text.startsWith("﻿")) 1 else 0

            fun keyPath(c: Ctx) = listOfNotNull(c.path.ifEmpty { null }, c.key).joinToString(".")

            while (i < text.length) {
                val c = text[i]
                when {
                    c.isWhitespace() || c == ',' -> i++
                    c == ':' -> { stack.lastOrNull()?.expectKey = false; i++ }
                    c == '/' && text.startsWith("//", i) -> i = text.indexOf('\n', i).let { if (it < 0) text.length else it }
                    c == '/' && text.startsWith("/*", i) -> i = text.indexOf("*/", i + 2).let { if (it < 0) return null else it + 2 }
                    c == '{' || c == '[' -> {
                        val parent = stack.lastOrNull()
                        val sensitive = parent != null && (parent.sensitive || (parent.isObject && rules.isSecretKey(parent.key)))
                        val path = when {
                            parent == null -> ""
                            parent.isObject -> keyPath(parent)
                            else -> parent.path
                        }
                        stack.addLast(Ctx(c == '{', sensitive, path))
                        i++
                    }
                    c == '}' || c == ']' -> {
                        stack.removeLastOrNull() ?: return null
                        stack.lastOrNull()?.let { if (it.isObject) it.expectKey = true }
                        i++
                    }
                    c == '"' -> {
                        val end = endOfString(text, i) ?: return null
                        val raw = text.substring(i + 1, end)
                        val top = stack.lastOrNull()
                        if (top != null && top.isObject && top.expectKey) {
                            top.key = unescape(raw)
                        } else {
                            val sensitive = top != null && (top.sensitive || (top.isObject && rules.isSecretKey(top.key)))
                            if (raw.isNotEmpty() && (sensitive || rules.isSecretValue(unescape(raw)))) {
                                spans += SecretSpan(i + 1, end, top?.let { if (it.isObject) keyPath(it) else it.path } ?: "")
                            }
                            if (top != null && top.isObject) top.expectKey = true
                        }
                        i = end + 1
                    }
                    else -> {
                        // number / true / false / null
                        val start = i
                        while (i < text.length && text[i] !in ",}] \t\r\n/") i++
                        if (i == start) return null
                        stack.lastOrNull()?.let { if (it.isObject) it.expectKey = true }
                    }
                }
            }
            return if (stack.isEmpty()) spans else null
        }

        private fun endOfString(text: String, open: Int): Int? {
            var i = open + 1
            while (i < text.length) {
                when (text[i]) {
                    '\\' -> i += 2
                    '"' -> return i
                    '\n' -> return null
                    else -> i++
                }
            }
            return null
        }

        private fun unescape(raw: String) = raw.replace("\\\"", "\"").replace("\\\\", "\\")
    }

    // --------------------------------------------------------------------------------------------
    // .properties: `key=value`, `key: value` or `key value`, with `\` line continuations.

    private object Properties {
        fun scan(text: String, rules: RedactionRules): List<SecretSpan> {
            val spans = mutableListOf<SecretSpan>()
            var lineStart = if (text.startsWith("﻿")) 1 else 0
            while (lineStart < text.length) {
                // A logical line runs until a newline that is not escaped by an odd number of `\`.
                var end = lineStart
                while (end < text.length) {
                    if (text[end] == '\n') {
                        var backslashes = 0
                        var k = end - 1
                        if (k >= lineStart && text[k] == '\r') k--
                        while (k >= lineStart && text[k] == '\\') { backslashes++; k-- }
                        if (backslashes % 2 == 0) break
                    }
                    end++
                }
                parseLine(text, lineStart, end, rules)?.let(spans::add)
                lineStart = end + 1
            }
            return spans
        }

        private fun parseLine(text: String, from: Int, to: Int, rules: RedactionRules): SecretSpan? {
            var i = from
            while (i < to && (text[i] == ' ' || text[i] == '\t' || text[i] == '\u000c')) i++
            if (i >= to || text[i] == '#' || text[i] == '!' || text[i] == '\r') return null
            val keyStart = i
            while (i < to && text[i] !in "=: \t\r") { if (text[i] == '\\') i++; i++ }
            val key = text.substring(keyStart, i.coerceAtMost(to)).replace("\\", "")
            while (i < to && (text[i] == ' ' || text[i] == '\t')) i++
            if (i < to && (text[i] == '=' || text[i] == ':')) i++
            while (i < to && (text[i] == ' ' || text[i] == '\t')) i++
            var end = to
            if (end > i && text[end - 1] == '\r') end--
            if (end <= i) return null
            val value = text.substring(i, end)
            return if (rules.isSecretKey(key) || rules.isSecretValue(value)) SecretSpan(i, end, key) else null
        }
    }

    // --------------------------------------------------------------------------------------------
    // TOML: tables, dotted keys, basic/literal strings (single- and multi-line) and string arrays.
    // Only string values are redacted, because a bare placeholder is not a valid TOML value.

    private object Toml {
        private val TABLE = Regex("^\\s*\\[\\[?\\s*([^\\]]+?)\\s*]]?\\s*(#.*)?$")

        fun scan(text: String, rules: RedactionRules): List<SecretSpan> {
            val spans = mutableListOf<SecretSpan>()
            var table = ""
            var pos = if (text.startsWith("﻿")) 1 else 0
            while (pos < text.length) {
                val nl = text.indexOf('\n', pos).let { if (it < 0) text.length else it }
                val line = text.substring(pos, nl)
                val header = TABLE.matchEntire(line.trimEnd('\r'))
                if (header != null) {
                    table = header.groupValues[1].replace("\"", "").replace("'", "")
                    pos = nl + 1
                    continue
                }
                val eq = keyValueSplit(line)
                if (eq == null) { pos = nl + 1; continue }
                val key = line.substring(0, eq).trim().replace("\"", "").replace("'", "")
                val full = listOf(table, key).filter { it.isNotEmpty() }.joinToString(".")
                val sensitive = rules.isSecretKey(full)
                var i = pos + eq + 1
                while (i < text.length && (text[i] == ' ' || text[i] == '\t')) i++
                val next = scanValue(text, i, sensitive, full, rules, spans)
                pos = (text.indexOf('\n', next).let { if (it < 0) text.length else it }) + 1
            }
            return spans
        }

        /** Index of the `=` that separates key and value, ignoring `=` inside quoted keys. */
        private fun keyValueSplit(line: String): Int? {
            val trimmed = line.trimStart()
            if (trimmed.isEmpty() || trimmed.startsWith("#")) return null
            var quote: Char? = null
            for ((i, c) in line.withIndex()) {
                when {
                    quote != null -> if (c == quote) quote = null
                    c == '"' || c == '\'' -> quote = c
                    c == '=' -> return i
                    c == '#' -> return null
                }
            }
            return null
        }

        /** Scans one value starting at [i]; returns the index just past it. */
        private fun scanValue(
            text: String,
            i: Int,
            sensitive: Boolean,
            key: String,
            rules: RedactionRules,
            spans: MutableList<SecretSpan>,
        ): Int {
            if (i >= text.length) return i
            return when {
                text.startsWith("\"\"\"", i) || text.startsWith("'''", i) -> {
                    val delim = text.substring(i, i + 3)
                    val close = text.indexOf(delim, i + 3)
                    if (close < 0) return text.length
                    val value = text.substring(i + 3, close)
                    if (value.isNotBlank() && (sensitive || rules.isSecretValue(value))) spans += SecretSpan(i + 3, close, key)
                    close + 3
                }
                text[i] == '"' || text[i] == '\'' -> {
                    val close = closingQuote(text, i) ?: return text.length
                    val value = text.substring(i + 1, close)
                    if (value.isNotEmpty() && (sensitive || rules.isSecretValue(value))) spans += SecretSpan(i + 1, close, key)
                    close + 1
                }
                text[i] == '[' -> {
                    var j = i + 1
                    while (j < text.length && text[j] != ']') {
                        j = if (text[j] == '"' || text[j] == '\'') scanValue(text, j, sensitive, key, rules, spans) else j + 1
                    }
                    j + 1
                }
                text[i] == '{' -> {
                    // Inline table: `{ user = "a", password = "b" }`.
                    var j = i + 1
                    while (j < text.length && text[j] != '}' && text[j] != '\n') {
                        val eq = text.indexOf('=', j)
                        if (eq < 0) break
                        val inner = text.substring(j, eq).trim().trim(',', ' ').replace("\"", "")
                        var v = eq + 1
                        while (v < text.length && text[v] == ' ') v++
                        j = scanValue(text, v, sensitive || rules.isSecretKey(inner), "$key.$inner", rules, spans)
                        while (j < text.length && (text[j] == ',' || text[j] == ' ')) j++
                    }
                    j + 1
                }
                else -> i
            }
        }

        private fun closingQuote(text: String, open: Int): Int? {
            val q = text[open]
            var j = open + 1
            while (j < text.length && text[j] != '\n') {
                if (q == '"' && text[j] == '\\') { j += 2; continue }
                if (text[j] == q) return j
                j++
            }
            return null
        }
    }

    // --------------------------------------------------------------------------------------------
    // HOCON (.conf): `key = value`, `key: value`, `key { … }` blocks, quoted/unquoted values.

    private object Hocon {
        private val OPEN = Regex("^\\s*\"?([^\"={:\\s]+)\"?\\s*[=:]?\\s*\\{\\s*(#.*|//.*)?$")
        private val PAIR = Regex("^(\\s*)\"?([^\"=:{}\\s#]+)\"?\\s*[=:]\\s*")

        fun scan(text: String, rules: RedactionRules): List<SecretSpan> {
            val spans = mutableListOf<SecretSpan>()
            val path = ArrayDeque<String>()
            var pos = if (text.startsWith("﻿")) 1 else 0
            while (pos < text.length) {
                val nl = text.indexOf('\n', pos).let { if (it < 0) text.length else it }
                val line = text.substring(pos, nl).trimEnd('\r')
                val trimmed = line.trim()
                when {
                    trimmed.isEmpty() || trimmed.startsWith("#") || trimmed.startsWith("//") -> Unit
                    OPEN.matches(line) -> path.addLast(OPEN.matchEntire(line)?.groupValues?.get(1) ?: "?")
                    trimmed.startsWith("}") -> path.removeLastOrNull()
                    else -> PAIR.find(line)?.let { m ->
                        val key = (path + m.groupValues[2]).joinToString(".")
                        val valueStart = pos + m.range.last + 1
                        valueSpan(text, valueStart, pos + line.length)?.let { (s, e) ->
                            val value = text.substring(s, e)
                            if (value.isNotEmpty() && (rules.isSecretKey(key) || rules.isSecretValue(value))) {
                                spans += SecretSpan(s, e, key)
                            }
                        }
                    }
                }
                pos = nl + 1
            }
            return spans
        }

        private fun valueSpan(text: String, start: Int, lineEnd: Int): Pair<Int, Int>? {
            if (start >= lineEnd) return null
            if (text[start] == '"') {
                if (text.startsWith("\"\"\"", start)) {
                    val close = text.indexOf("\"\"\"", start + 3)
                    return if (close < 0) null else (start + 3) to close
                }
                var j = start + 1
                while (j < lineEnd) {
                    if (text[j] == '\\') { j += 2; continue }
                    if (text[j] == '"') return (start + 1) to j
                    j++
                }
                return null
            }
            if (text[start] == '{' || text[start] == '[') return null
            var end = start
            while (end < lineEnd && text[end] != ',' && text[end] != '}' && text[end] != '#' && !text.startsWith("//", end)) end++
            while (end > start && text[end - 1].isWhitespace()) end--
            return if (end > start) start to end else null
        }
    }

    // --------------------------------------------------------------------------------------------
    // Fallback for files that don't parse: `key: value` / `key = value` per line.

    private object Lines {
        private val PAIR = Regex("^\\s*(?:-\\s+)?[\"']?([A-Za-z0-9_.\\- ]+?)[\"']?\\s*[:=]\\s*(.*?)\\s*$")

        fun scan(text: String, rules: RedactionRules): List<SecretSpan> {
            val spans = mutableListOf<SecretSpan>()
            var pos = 0
            for (rawLine in text.split('\n')) {
                val line = rawLine.trimEnd('\r')
                PAIR.matchEntire(line)?.let { m ->
                    val valueGroup = m.groups[2]
                    if (valueGroup != null && valueGroup.value.isNotEmpty()) {
                        var s = valueGroup.range.first
                        var e = valueGroup.range.last + 1
                        val v = line.substring(s, e)
                        val comment = v.indexOf(" #")
                        if (comment >= 0 && v.first() != '"' && v.first() != '\'') e = s + comment
                        while (e > s && (line[e - 1] == ',' || line[e - 1] == ' ')) e--
                        if (e - s >= 2 && (line[s] == '"' || line[s] == '\'') && line[e - 1] == line[s]) { s++; e-- }
                        val value = line.substring(s, e)
                        if (value.isNotEmpty() && (rules.isSecretKey(m.groupValues[1]) || rules.isSecretValue(value))) {
                            spans += SecretSpan(pos + s, pos + s + value.length, m.groupValues[1])
                        }
                    }
                }
                pos += rawLine.length + 1
            }
            return spans
        }
    }
}
