from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class GLRule:
    section: Optional[str]
    applicability: str
    reason: str
    source: str


def lookup_gl_rule(gl_account: Any = None, gl_description: Any = None) -> Optional[GLRule]:
    """GL account numbers are not used for section/applicability decisions.

    The same GL account can contain multiple valid TDS sections, so expected
    section must come from transaction-level nature/description instead.
    """
    return None


def apply_gl_rule(txn: Any) -> Any:
    return txn
