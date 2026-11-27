"""Filters for the logging setup in backend/log_config.json."""

import logging


class ErrorsAndFailedRequests(logging.Filter):
    """Lets through warnings and errors, plus API calls that failed (status 400 or above).

    Used on the log file so it records what went wrong without every successful
    request; the terminal still shows everything.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno >= logging.WARNING:
            return True
        if record.name == "uvicorn.access":
            # uvicorn's access record args: (client, method, path, http_version, status_code)
            args = record.args if isinstance(record.args, tuple) else ()
            try:
                return len(args) >= 5 and int(args[4]) >= 400
            except (TypeError, ValueError):
                return False
        return False
