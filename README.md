# TDS Issue Detection System

AI-assisted TDS (Tax Deducted at Source) deduction issue detection system, built for Mahindra & Mahindra. The system identifies, flags, and reports TDS compliance errors across applicable sections of the Income Tax Act, 1961, processing ERP/SAP data at scale across multiple company codes.

## Client

Mahindra & Mahindra

## Company Codes in Scope

1001, 1079, 1081

## Tech Stack

- **Backend:** Python, FastAPI, SQLAlchemy, Alembic
- **Database:** PostgreSQL
- **Authentication:** JWT (python-jose), bcrypt password hashing (passlib)
- **Data Ingestion:** Google Cloud BigQuery (pending Mahindra access)
- **Scheduler:** APScheduler
- **Export:** openpyxl
- **Frontend:** React (developed separately)

## Project Structure

```
TDS-Issue-Detection-System/
├── backend/
│   ├── api/            # FastAPI route handlers (auth, admin, dashboard, issues, export)
│   ├── config/          # TDS section rules and GL account mapping (YAML)
│   ├── core/             # Security (JWT, hashing), dependencies (auth checks)
│   ├── db/               # SQLAlchemy models and database connection
│   ├── ingestion/        # GCP BigQuery client and mock data client
│   ├── migrations/       # Alembic database migrations
│   ├── rules/            # TDS rule engine logic
│   ├── schemas/          # Pydantic request/response models
│   ├── services/         # Business logic (processor, email service)
│   ├── tests/            # Unit tests
│   ├── main.py           # FastAPI app entry point
│   ├── scheduler.py       # Daily automated job trigger
│   ├── alembic.ini
│   ├── requirements.txt
│   └── .env              # Environment config (not committed)
├── frontend/              # React frontend (separate developer)
├── _reference_old_backend/ # POC reference (not pushed to repo)
└── README.md
```

## Setup Instructions

### 1. Clone and set up virtual environment

```bash
cd backend
python -m venv venv
Windows: venv\Scripts\activate    # Linex: source venv/bin/activate 
pip install -r requirements.txt
```

### 2. Configure environment variables

Create a `.env` file inside `backend/` with:

```env
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<dbname>
JWT_SECRET_KEY=<generate with: python -c "import secrets; print(secrets.token_hex(32))">
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=480
```

### 3. Set up PostgreSQL database

```sql
CREATE DATABASE <dbname>;
CREATE USER <user> WITH PASSWORD '<password>';
GRANT ALL PRIVILEGES ON SCHEMA public TO <user>;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO <user>;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO <user>;
```

### 4. Run database migrations

```bash
cd backend
alembic upgrade head
```

### 5. Run the server

```bash
uvicorn main:app --reload
```

API will be available at `http://127.0.0.1:8000`
Interactive docs at `http://127.0.0.1:8000/docs`

## Authentication & Roles

Two roles are supported:

- **admin** — full access; manages users and company code assignments; implicitly has access to all company codes
- **accountant** — restricted to only the company codes explicitly assigned by an admin

### Auth Flow

1. `POST /auth/login` with email/password returns a JWT `access_token`
2. Include the token on all subsequent requests: `Authorization: Bearer <token>`
3. Token expires after 8 hours (configurable via `JWT_EXPIRE_MINUTES`)

## Key API Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | No | Health check |
| `/auth/login` | POST | No | Login, returns JWT |
| `/auth/register` | POST | Admin | Create user (bootstrap) |
| `/admin/users` | GET | Admin | List all users |
| `/admin/users` | POST | Admin | Create new user |
| `/admin/users/assign-company-code` | POST | Admin | Grant company code access |
| `/admin/users/{id}/company-code/{code}` | DELETE | Admin | Revoke company code access |
| `/admin/users/{id}/deactivate` | PATCH | Admin | Deactivate user |
| `/admin/users/{id}/activate` | PATCH | Admin | Reactivate user |

## Scope

Covers TDS sections: 193, 194, 194A, 194C, 194H, 194I, 194IA, 194J, 194K, 194LA, 194N, 194O, 194Q, 195, 196A, 196B, 196C, 196D, and renamed sections 392 (old 192) and 393 (old 192A), effective 1st April 2026.

TCS is out of scope. Certain sections (194B, 194BA, 194BB, 194D, 194R, 194S, 194T, 194P, 194M, 194IB, and others) are excluded from this release — see `backend/config/tds_sections.yaml` for full details.

## Status

- ✅ Backend authentication and role-based access — complete and tested
- ✅ TDS rules configuration (YAML-based) — complete
- 🔄 GCP/BigQuery data ingestion — pending Mahindra access
- 🔄 Dashboard, issues, threshold tracker, export APIs — pending data ingestion
- 🔄 Frontend — in progress (separate developer)

## Notes

- Rules (TDS rates, thresholds, GL account mapping) are config-driven via YAML — changes don't require code redeployment
- System flags issues for human review only; does not auto-correct transactions
- Export functionality will be capped at 1 month of data due to volume
