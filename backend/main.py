from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from api import auth
from api import admin
from api import issues
from api import ldc
from api import pan

app = FastAPI(title="TDS Issue Detection System")

# Upload results run to tens of MB of repetitive JSON; gzip cuts the download
# roughly tenfold and the browser decompresses it transparently. Level 5
# keeps compression time low compared with the default of 9.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://192.168.10.178:5173",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}):5173$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(issues.router)
app.include_router(ldc.router)
app.include_router(pan.router)


@app.get("/")
def root():
    return {"message": "TDS Issue Detection System API is running"}


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "TDS Issue Detection System API",
        "version": "1.0.0"
    }
