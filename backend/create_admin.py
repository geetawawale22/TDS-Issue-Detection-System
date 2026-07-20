from db.database import SessionLocal
from db.models import User
from core.security import hash_password
 
 
def seed_admin():
    """
    Creates the default admin user if it does not already exist.
    """
 
    db = SessionLocal()
 
    try:
        # Check whether admin already exists
        existing_admin = (
            db.query(User)
            .filter(User.email == "samrudhi.neve@kriosispl.com")
            .first()
        )
 
        if existing_admin:
            print("Admin user already exists.")
            return
 
        admin = User(
            username="admin",
            full_name="System Administrator",
            email="samrudhi.neve@kriosispl.com",
            hashed_password=hash_password("Admin@123"),
            role="admin",
            is_active=True,
            created_by=None
        )
 
        db.add(admin)
        db.commit()
 
        print("Admin user created successfully.")
 
    except Exception as e:
        db.rollback()
        print(f"Error: {e}")
 
    finally:
        db.close()
 
 
if __name__ == "__main__":
    seed_admin()
