from pydantic import BaseModel, EmailStr, field_validator
from typing import List, Optional
from datetime import datetime


class UserCreate(BaseModel):
    """Used when Admin creates a new user."""
    full_name: str
    username: str
    email: EmailStr
    role: str = "accountant"   # "admin" or "accountant"


class UserOut(BaseModel):
    id: int
    full_name: str
    username: str
    email: EmailStr
    role: str
    is_active: bool
    created_by: Optional[int] = None
    created_at: datetime
    company_codes: List[str] = []

    @field_validator("company_codes", mode="before")
    @classmethod
    def extract_company_codes(cls, value):
        """
        The ORM relationship gives us a list of CompanyCodeAccess objects.
        Convert them into a plain list of company code strings for the response.
        """
        if value and hasattr(value[0], "company_code"):
            return [item.company_code for item in value]
        return value

    class Config:
        from_attributes = True

class CompanyCodeAssign(BaseModel):
    """Used when Admin assigns a company code to a user."""
    user_id: int
    company_code: str   # "1001", "1079", or "1081"