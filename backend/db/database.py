from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from dotenv import load_dotenv
import os
from pathlib import Path

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Create backend/.env with "
        "DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<dbname>"
    )

# Engine is the actual connection to PostgreSQL
# pool_size=10 means 10 connections stay open (handles concurrent requests)
# max_overflow=20 means up to 20 extra connections under heavy load
# For 20-50L rows, connection pooling is important
engine = create_engine(
    DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True  # checks connection is alive before using it
)

# SessionLocal is what your API routes will use to talk to DB
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base is the parent class all your models will inherit from
Base = declarative_base()


def get_db():
    """
    Dependency function for FastAPI routes.
    Opens a DB session, yields it, closes it when request is done.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
