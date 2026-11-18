package dev.jeary.kaizen.core.protocol

/** Failure reasons from protocol §10. The wire names are shared with the web app. */
enum class Reason(val wire: String) {
    MALFORMED("malformed"),
    UNSUPPORTED("unsupported"),
    AUTH("auth"),
    OVERSIZE("oversize"),
    MISMATCH("mismatch"),
    PATH("path"),
    PLACEHOLDER("placeholder"),
}

class ProtocolException(val reason: Reason, message: String, cause: Throwable? = null) :
    Exception(message, cause)

internal fun fail(reason: Reason, message: String, cause: Throwable? = null): Nothing =
    throw ProtocolException(reason, message, cause)
