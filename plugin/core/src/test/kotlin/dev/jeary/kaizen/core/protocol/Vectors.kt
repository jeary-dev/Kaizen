package dev.jeary.kaizen.core.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/** Loads the shared vectors from /protocol, the same file the web app's tests read. */
object Vectors {
    val protocolDir: Path by lazy {
        val configured = System.getProperty("kaizen.protocolDir")
        val candidates = listOfNotNull(configured?.let(Paths::get), Paths.get("../../protocol"), Paths.get("../protocol"))
        candidates.map { it.toAbsolutePath().normalize() }
            .firstOrNull { Files.isRegularFile(it.resolve("test-vectors/v1.json")) }
            ?: error("protocol/test-vectors/v1.json not found (tried $candidates)")
    }

    val root: JsonObject by lazy {
        Json.parseToJsonElement(Files.readString(protocolDir.resolve("test-vectors/v1.json"))).jsonObject
    }

    fun list(name: String): List<JsonObject> = root.getValue(name).jsonArray.map { it.jsonObject }

    fun group(name: String): JsonObject = root.getValue(name).jsonObject
}

fun JsonObject.str(name: String): String = getValue(name).jsonPrimitive.content
fun JsonObject.int(name: String): Int = getValue(name).jsonPrimitive.int
fun JsonObject.strOrNull(name: String): String? = (get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonElement.strings(): List<String> = (this as JsonArray).map { it.jsonPrimitive.content }
