# Database Setup Instructions for TDS Application

This project now supports both **PostgreSQL** and **MySQL** through `DATABASE_URL`.

- Developer laptop can continue using PostgreSQL.
- Client laptop can use MySQL.
- No code change is needed between laptops; only `backend/.env` changes.

---

## 0. Choose Database in `.env`

### PostgreSQL example

Use this on the developer laptop if PostgreSQL is already working:

```env
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<dbname>
```

### MySQL example

Use this on the client laptop:

```env
DATABASE_URL=mysql+pymysql://tds_user:tds_password@localhost:3306/tds_app?charset=utf8mb4
```

Then follow the MySQL setup below only on laptops that use MySQL.

---

## 1. Install MySQL

### Option A: Windows

1. Download MySQL Installer:

```text
https://dev.mysql.com/downloads/installer/
```

2. Install these components:

```text
MySQL Server 8.x
MySQL Workbench
MySQL Shell, optional
```

3. During installation, set a root password and remember it.

Example:

```text
root password: your_mysql_password
```

4. Confirm MySQL service is running.

Open Command Prompt and run:

```cmd
mysql --version
```

If `mysql` is not recognized, add MySQL bin path to Windows PATH. Usually it is:

```text
C:\Program Files\MySQL\MySQL Server 8.0\bin
```

Then reopen Command Prompt.

---

### Option B: Ubuntu / Linux

```bash
sudo apt update
sudo apt install mysql-server -y
sudo systemctl start mysql
sudo systemctl enable mysql
mysql --version
```

Set/secure root password if needed:

```bash
sudo mysql_secure_installation
```

---

## 2. Create MySQL Database and User

Login to MySQL.

### Windows / Linux

```bash
mysql -u root -p
```

Enter your MySQL root password.

Then run these SQL commands:

```sql
CREATE DATABASE tds_app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'tds_user'@'localhost' IDENTIFIED BY 'tds_password';

GRANT ALL PRIVILEGES ON tds_app.* TO 'tds_user'@'localhost';

FLUSH PRIVILEGES;
```

Check database exists:

```sql
SHOW DATABASES;
```

Exit MySQL:

```sql
EXIT;
```

---

## 3. Pull the Project Code

Go to the folder where you want the project.

```bash
git clone <YOUR_REPO_URL>
cd "TDS-new approach"
```

If repo is already present:

```bash
git pull
```

---

## 4. Create Backend `.env`

Go to backend folder:

```bash
cd backend
```

Create or edit `.env` file.

For MySQL, use this:

```env
DATABASE_URL=mysql+pymysql://tds_user:tds_password@localhost:3306/tds_app
```

If password contains special characters like `@`, `#`, `%`, `/`, encode them or use a simple password first.

Example:

```env
DATABASE_URL=mysql+pymysql://tds_user:tds_password@localhost:3306/tds_app
SECRET_KEY=change_this_secret_key
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=1440
```

Keep any other existing email/GCP settings from your original `.env` if required.

---

## 5. Create Python Virtual Environment

From `backend` folder:

### Windows

```cmd
python -m venv .venv
.venv\Scripts\activate
```

### Linux / Mac

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Upgrade pip:

```bash
python -m pip install --upgrade pip
```

---

## 6. Install Backend Dependencies

From `backend` folder:

```bash
pip install -r requirements.txt
```

The project requirements include both PostgreSQL and MySQL drivers. If PyMySQL is still missing, install it manually:

```bash
pip install PyMySQL
```

Verify driver is installed:

```bash
python -c "import pymysql; print('PyMySQL installed')"
```

---

## 7. Run Database Migrations

From `backend` folder:

```bash
alembic upgrade head
```

If this succeeds, tables are created in MySQL.

Check in MySQL:

```bash
mysql -u tds_user -p tds_app
```

Then:

```sql
SHOW TABLES;
EXIT;
```

---

## 8. If Migration Fails Because of PostgreSQL-Specific Migration

If you see an error related to PostgreSQL dialect, for example:

```text
sqlalchemy.dialects.postgresql
```

then the existing migration file has PostgreSQL-specific code.

In that case, ask the developer to make migrations database-neutral for MySQL.

This is usually a **small to medium migration fix**, not a full project rewrite.

Do not manually delete migration files unless the developer confirms.

---

## 9. Start Backend Server

From `backend` folder, with virtual environment activated:

```bash
uvicorn main:app --reload
```

Backend should run at:

```text
http://127.0.0.1:8000
```

Check API health:

```text
http://127.0.0.1:8000
```

---

## 10. Install Frontend Dependencies

Open a new terminal.

Go to frontend folder:

```bash
cd "Frontend/TDS"
```

Install packages:

```bash
npm install
```

Start frontend:

```bash
npm run dev
```

Frontend usually runs at:

```text
http://localhost:5173
```

If port is busy, Vite will show another port like:

```text
http://localhost:5174
```

---

## 11. Common Problems

### Problem: `mysql` command not found

Add MySQL bin folder to PATH.

Windows common path:

```text
C:\Program Files\MySQL\MySQL Server 8.0\bin
```

Then reopen terminal.

---

### Problem: `ModuleNotFoundError: No module named 'pymysql'`

Run inside backend virtual environment:

```bash
pip install PyMySQL
```

---

### Problem: Access denied for MySQL user

Login as root:

```bash
mysql -u root -p
```

Then run again:

```sql
ALTER USER 'tds_user'@'localhost' IDENTIFIED BY 'tds_password';
GRANT ALL PRIVILEGES ON tds_app.* TO 'tds_user'@'localhost';
FLUSH PRIVILEGES;
```

---

### Problem: Backend says `DATABASE_URL is not set`

Make sure file exists:

```text
backend/.env
```

And contains:

```env
DATABASE_URL=mysql+pymysql://tds_user:tds_password@localhost:3306/tds_app
```

Restart backend after changing `.env`.

---

## 12. Final Run Checklist

Backend:

```bash
cd backend
.venv\Scripts\activate     # Windows
# OR
source .venv/bin/activate   # Linux/Mac

uvicorn main:app --reload
```

Frontend:

```bash
cd "Frontend/TDS"
npm run dev
```

Open browser:

```text
http://localhost:5173
```

---

## Important Note

The same codebase can run with PostgreSQL or MySQL. The selected database is controlled by `backend/.env` through `DATABASE_URL`.

If `alembic upgrade head` fails, share the full error with the developer.
