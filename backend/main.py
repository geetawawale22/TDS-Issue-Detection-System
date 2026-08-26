from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api import auth
from api import admin
from api import issues
from api import ldc

app = FastAPI(title="TDS Issue Detection System")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://192.168.10.178:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(issues.router)
app.include_router(ldc.router)


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
