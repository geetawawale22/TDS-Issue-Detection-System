from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api import auth
from api import admin
from api import issues

app = FastAPI(title="TDS Issue Detection System")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(issues.router)


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

