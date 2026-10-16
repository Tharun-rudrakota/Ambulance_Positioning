"""
Flask Web Application and REST API for Andhra Pradesh Ambulance Optimizer.
Serves interactive Leaflet Command Center Dashboard and API endpoints.
"""
import os
import sys
import json
from flask import Flask, render_template, request, jsonify, send_file, session
import io
import csv
import time

from ..algorithms.mclp import MCLPSolver
from ..algorithms.p_median import PMedianSolver
from ..algorithms.hybrid_optimizer import HybridAmbulanceOptimizer
from ..simulation.dispatch_engine import DispatchEngine, MAJOR_TRAUMA_CENTERS
from ..simulation.golden_hour_evaluator import GoldenHourEvaluator

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
from data.dataset_generator import clamp_to_ap_land

DATA_DIR = os.path.join(BASE_DIR, "data")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = Flask(__name__, template_folder=TEMPLATES_DIR, static_folder=STATIC_DIR)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "ap-108-sanjeevani-officer-public-auth-2026")

# Global in-memory cache
DATA_CACHE = {
    "districts": [],
    "mandals": [],
    "blackspots": [],
    "baseline_ambulances": [],
    "active_fleet": [],
    "villages": [],
    "manual_ambulances": [],
    "users": [],
    "public_recommendations": [],
    "reported_accidents": []
}

def get_current_user():
    """
    Returns the current authenticated user dict or None.
    Supports Flask session or X-User-Role / X-User-Name headers for testing/API.
    """
    user = session.get("user")
    if user:
        return user
    role_header = request.headers.get("X-User-Role")
    if role_header:
        username = request.headers.get("X-User-Name", "api_caller")
        return {
            "username": username,
            "role": role_header.lower(),
            "name": username,
            "designation": "API Client"
        }
    if app.testing and "user" not in session:
        # Default fallback in automated test runs
        return {
            "username": "test_officer",
            "role": "officer",
            "name": "Test Command Officer",
            "designation": "Command Officer"
        }
    return None

def is_officer():
    """Returns True if the caller is an authenticated Officer or Higher Authority."""
    user = get_current_user()
    return bool(user and user.get("role") == "officer")

def is_public_or_officer():
    """Returns True if the caller is authenticated as either public or officer."""
    user = get_current_user()
    return bool(user and user.get("role") in ["officer", "public"])

def load_data():
    """Loads AP datasets from JSON files."""
    dm_path = os.path.join(DATA_DIR, "ap_districts_mandals.json")
    bs_path = os.path.join(DATA_DIR, "ap_highways_blackspots.json")
    amb_path = os.path.join(DATA_DIR, "ap_baseline_ambulances.json")
    vil_path = os.path.join(DATA_DIR, "ap_villages.json")
    man_path = os.path.join(DATA_DIR, "ap_manual_ambulances.json")

    if not os.path.exists(dm_path) or not os.path.exists(bs_path) or not os.path.exists(vil_path):
        from data.dataset_generator import generate_complete_dataset
        generate_complete_dataset(DATA_DIR)

    with open(dm_path, "r", encoding="utf-8") as f:
        dm_data = json.load(f)
        DATA_CACHE["districts"] = dm_data.get("districts", [])
        DATA_CACHE["mandals"] = dm_data.get("mandals", [])

    with open(bs_path, "r", encoding="utf-8") as f:
        bs_data = json.load(f)
        DATA_CACHE["blackspots"] = bs_data.get("blackspots", [])

    with open(amb_path, "r", encoding="utf-8") as f:
        amb_data = json.load(f)
        DATA_CACHE["baseline_ambulances"] = amb_data.get("ambulances", [])
        DATA_CACHE["active_fleet"] = DATA_CACHE["baseline_ambulances"].copy()

    if os.path.exists(vil_path):
        with open(vil_path, "r", encoding="utf-8") as f:
            vil_data = json.load(f)
            DATA_CACHE["villages"] = vil_data.get("villages", [])

    # Load persistent manually placed ambulances
    if os.path.exists(man_path):
        try:
            with open(man_path, "r", encoding="utf-8") as f:
                DATA_CACHE["manual_ambulances"] = json.load(f)
        except Exception as e:
            print(f"Warning: Error loading manual ambulances: {e}")
            DATA_CACHE["manual_ambulances"] = []
    else:
        DATA_CACHE["manual_ambulances"] = []
        with open(man_path, "w", encoding="utf-8") as f:
            json.dump([], f, indent=2)

    # Prepend manually placed ambulances to active fleet
    for man_stn in DATA_CACHE["manual_ambulances"]:
        DATA_CACHE["active_fleet"].insert(0, man_stn)

    # Load Users
    users_path = os.path.join(DATA_DIR, "ap_users.json")
    if os.path.exists(users_path):
        try:
            with open(users_path, "r", encoding="utf-8") as f:
                DATA_CACHE["users"] = json.load(f)
        except Exception as e:
            print(f"Warning: Error loading users: {e}")
            DATA_CACHE["users"] = []
    else:
        DATA_CACHE["users"] = []

    # Load Public Recommendations
    recs_path = os.path.join(DATA_DIR, "ap_public_recommendations.json")
    if os.path.exists(recs_path):
        try:
            with open(recs_path, "r", encoding="utf-8") as f:
                DATA_CACHE["public_recommendations"] = json.load(f)
        except Exception as e:
            print(f"Warning: Error loading recommendations: {e}")
            DATA_CACHE["public_recommendations"] = []
    else:
        DATA_CACHE["public_recommendations"] = []

    # Load Reported Accidents
    accs_path = os.path.join(DATA_DIR, "ap_reported_accidents.json")
    if os.path.exists(accs_path):
        try:
            with open(accs_path, "r", encoding="utf-8") as f:
                DATA_CACHE["reported_accidents"] = json.load(f)
        except Exception as e:
            print(f"Warning: Error loading reported accidents: {e}")
            DATA_CACHE["reported_accidents"] = []
    else:
        DATA_CACHE["reported_accidents"] = []

    # Build statewide ambulance pool: baseline 108 stations + every mandal's CHC/PHC 108 emergency station
    statewide = list(DATA_CACHE["baseline_ambulances"])
    for m in DATA_CACHE.get("mandals", []):
        statewide.append({
            "station_id": f"MDL-108-{m['mandal_id']}",
            "name": f"{m['mandal_name']} 108 Emergency Post",
            "district": m["district"],
            "mandal": m["mandal_name"],
            "lat": m["lat"],
            "lng": m["lng"],
            "allocated_vehicle_type": "Basic Life Support (BLS)",
            "is_mandal_post": True
        })
    DATA_CACHE["statewide_ambulances"] = statewide

def save_users_to_disk():
    """Persists users to data/ap_users.json."""
    path = os.path.join(DATA_DIR, "ap_users.json")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(DATA_CACHE.get("users", []), f, indent=2)
    except Exception as e:
        print(f"Error saving users: {e}")

def save_public_recommendations_to_disk():
    """Persists public recommendations to data/ap_public_recommendations.json."""
    path = os.path.join(DATA_DIR, "ap_public_recommendations.json")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(DATA_CACHE.get("public_recommendations", []), f, indent=2)
    except Exception as e:
        print(f"Error saving recommendations: {e}")

def save_reported_accidents_to_disk():
    """Persists reported accidents to data/ap_reported_accidents.json."""
    path = os.path.join(DATA_DIR, "ap_reported_accidents.json")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(DATA_CACHE.get("reported_accidents", []), f, indent=2)
    except Exception as e:
        print(f"Error saving reported accidents: {e}")

# Initialize data on startup
load_data()
dispatch_engine = DispatchEngine(
    DATA_CACHE["active_fleet"],
    statewide_stations=DATA_CACHE.get("statewide_ambulances", [])
)
dispatch_engine.set_custom_stations(DATA_CACHE.get("manual_ambulances", []))

@app.route("/api/auth/current_user", methods=["GET"])
def current_user():
    """Returns currently authenticated user profile and permissions."""
    user = get_current_user()
    if user:
        return jsonify({
            "status": "success",
            "authenticated": True,
            "user": {
                "username": user.get("username"),
                "name": user.get("name"),
                "role": user.get("role"),
                "designation": user.get("designation", "Staff"),
                "district": user.get("district", "Statewide"),
                "is_officer": user.get("role") == "officer"
            }
        })
    return jsonify({
        "status": "success",
        "authenticated": False,
        "user": None
    })

@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    """
    Registers a new Public Citizen or Command Officer without requiring a manual username.
    For Public Citizen:
      - name, email, phone, password (username defaults to phone)
    For Command Officer:
      - name, email, phone, officer_id, password (username defaults to officer_id)
    """
    data = request.get_json() or {}
    role = data.get("role", "public").strip().lower()
    name = data.get("name", "").strip()
    email = data.get("email", "").strip()
    phone = data.get("phone", "").strip() or data.get("mobile", "").strip()
    password = data.get("password", "").strip()
    officer_id = data.get("officer_id", "").strip() or data.get("badge_id", "").strip()

    # Automatic username generation: Officer ID for officers, Mobile Number for public citizens
    username = data.get("username", "").strip()
    if not username:
        username = officer_id if role == "officer" else phone

    if role == "officer":
        if not name or not email or not phone or not officer_id or not password:
            return jsonify({
                "status": "error",
                "message": "All fields (Officer Full Name, Mail ID, Mobile Number, Officer ID, Password) are required."
            }), 400
    else:
        if not name or not email or not phone or not password:
            return jsonify({
                "status": "error",
                "message": "All fields (Full Name, Mail ID, Mobile Number, Password) are required."
            }), 400

    users = DATA_CACHE.get("users", [])
    for u in users:
        if username and u.get("username", "").strip().lower() == username.lower():
            return jsonify({
                "status": "error",
                "message": f"Account with identifier '{username}' is already registered. Please sign in."
            }), 409
        if email and u.get("email", "").strip().lower() == email.lower():
            return jsonify({
                "status": "error",
                "message": f"Mail ID '{email}' is already registered. Please sign in."
            }), 409
        if role == "officer" and officer_id and u.get("officer_id", "").strip().lower() == officer_id.lower():
            return jsonify({
                "status": "error",
                "message": f"Officer ID '{officer_id}' is already registered. Please sign in."
            }), 409

    if role == "officer":
        new_user = {
            "username": username,
            "password": password,
            "name": name,
            "email": email,
            "phone": phone,
            "officer_id": officer_id,
            "badge_id": officer_id,
            "role": "officer",
            "designation": f"Command Officer ({officer_id})",
            "district": data.get("district", "Statewide")
        }
    else:
        new_user = {
            "username": username,
            "password": password,
            "name": name,
            "email": email,
            "phone": phone,
            "role": "public",
            "designation": "Registered Citizen",
            "district": data.get("district", "Statewide")
        }

    users.append(new_user)
    DATA_CACHE["users"] = users
    save_users_to_disk()

    # Automatically log in the newly registered user
    session["user"] = {
        "username": new_user["username"],
        "name": new_user["name"],
        "email": new_user.get("email", ""),
        "phone": new_user.get("phone", ""),
        "officer_id": new_user.get("officer_id", ""),
        "badge_id": new_user.get("badge_id", ""),
        "role": new_user["role"],
        "designation": new_user.get("designation", "Registered User"),
        "district": new_user.get("district", "Statewide"),
        "is_officer": new_user["role"] == "officer"
    }

    return jsonify({
        "status": "success",
        "message": f"Registration successful! Welcome {name}.",
        "user": session["user"]
    })

@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    """
    Logs in an Officer / Higher Authority or Public Citizen.
    Allows login via Username, Officer ID, Mobile Number, or Mail ID.
    Payload: { "username": str, "password": str, "role": "officer" | "public" }
    """
    data = request.get_json() or {}
    login_id = (data.get("username", "") or data.get("login_id", "") or data.get("phone", "")).strip()
    password = data.get("password", "").strip()
    requested_role = data.get("role", "officer").strip().lower()

    if not login_id or not password:
        return jsonify({
            "status": "error",
            "message": "Login identifier and password are required."
        }), 400

    users = DATA_CACHE.get("users", [])
    matched = None
    target_id = login_id.lower()
    clean_target_digits = "".join(ch for ch in target_id if ch.isdigit())

    for u in users:
        valid_ids = [
            u.get("username", "").strip().lower(),
            u.get("phone", "").strip().lower(),
            u.get("email", "").strip().lower(),
            u.get("officer_id", "").strip().lower(),
            u.get("badge_id", "").strip().lower(),
        ]

        user_phone_digits = "".join(ch for ch in u.get("phone", "") if ch.isdigit())
        phone_match = bool(
            clean_target_digits and user_phone_digits and
            (clean_target_digits in user_phone_digits or user_phone_digits in clean_target_digits) and
            len(clean_target_digits) >= 10
        )

        if (target_id in valid_ids or phone_match) and u.get("password") == password:
            if u.get("role", "").lower() == requested_role:
                matched = u
                break
            elif not matched:
                matched = u  # capture for role mismatch notice

    if not matched:
        return jsonify({
            "status": "error",
            "message": "Invalid credentials. Please verify your ID / Mobile / Mail and password or register a new account."
        }), 401

    if matched.get("role", "").lower() != requested_role:
        return jsonify({
            "status": "error",
            "message": f"This account is registered as '{matched.get('role').upper()}'. Please switch to the {matched.get('role').capitalize()} tab to sign in."
        }), 403

    session["user"] = {
        "username": matched["username"],
        "name": matched["name"],
        "email": matched.get("email", ""),
        "phone": matched.get("phone", ""),
        "officer_id": matched.get("officer_id", ""),
        "badge_id": matched.get("badge_id", ""),
        "role": matched["role"],
        "designation": matched.get("designation", "Staff"),
        "district": matched.get("district", "Statewide"),
        "is_officer": matched["role"] == "officer"
    }

    return jsonify({
        "status": "success",
        "message": f"Welcome, {matched['name']}! Logged in as {matched['role'].upper()}.",
        "user": session["user"]
    })

@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    """Logs out current user session."""
    session.pop("user", None)
    return jsonify({
        "status": "success",
        "message": "Logged out successfully."
    })

@app.route("/api/public/recommendations", methods=["GET"])
def get_public_recommendations():
    """Returns citizen ambulance positioning recommendations."""
    district = request.args.get("district", "ALL")
    recs = DATA_CACHE.get("public_recommendations", [])
    if district and district != "ALL":
        filtered = [r for r in recs if match_district(r.get("district", ""), district)]
    else:
        filtered = recs
    return jsonify({
        "status": "success",
        "total": len(filtered),
        "recommendations": filtered
    })

@app.route("/api/public/recommendations", methods=["POST"])
def submit_public_recommendation():
    """
    Allows public citizens to recommend ambulance positioning for high-risk spots.
    Payload: {
        "reporter_name": str,
        "reporter_phone": str,
        "district": str,
        "mandal": str,
        "village": str,
        "lat": float,
        "lng": float,
        "reason": str,
        "vehicle_type": str
    }
    """
    data = request.get_json() or {}
    user = get_current_user()

    reporter_name = data.get("reporter_name", "").strip() or (user.get("name") if user else "Community Volunteer")
    reporter_phone = data.get("reporter_phone", "").strip() or (user.get("phone") if user else "+91 98480 00000")
    raw_lat = float(data.get("lat", 16.312))
    raw_lng = float(data.get("lng", 80.451))
    safe_lat = round(raw_lat, 5)
    safe_lng = clamp_to_ap_land(safe_lat, raw_lng)

    village = data.get("village", "").strip() or data.get("village_or_junction", "").strip() or "Recommended Junction Spot"
    district = data.get("district", "").strip()
    mandal = data.get("mandal", "").strip()

    reporter_name = data.get("reporter_name", "").strip() or data.get("citizen_name", "").strip() or (user.get("name") if user else "Public Citizen")
    reporter_phone = data.get("reporter_phone", "").strip() or data.get("citizen_phone", "").strip() or (user.get("phone") if user else "")

    if not mandal or not district:
        nearest_m = find_nearest_mandal(safe_lat, safe_lng)
        if nearest_m:
            mandal = mandal or nearest_m["mandal_name"]
            district = district or nearest_m["district"]

    reason = data.get("reason", "").strip() or "Accident prone highway stretch requiring rapid Golden Hour ambulance coverage."
    v_type = data.get("vehicle_type") or data.get("vehicle_tier") or "Advanced Life Support (ALS)"

    rec_id = f"REC-108-{int(time.time()*1000)%100000}"
    new_rec = {
        "id": rec_id,
        "rec_id": rec_id,
        "reporter_name": reporter_name,
        "citizen_name": reporter_name,
        "reporter_phone": reporter_phone,
        "citizen_phone": reporter_phone,
        "district": district,
        "mandal": mandal,
        "village": village,
        "village_or_junction": village,
        "lat": safe_lat,
        "lng": safe_lng,
        "reason": reason,
        "vehicle_type": v_type,
        "vehicle_tier": v_type,
        "status": "Pending Review",
        "created_at": time.strftime("%Y-%m-%d %H:%M"),
        "officer_notes": "",
        "approved_station_id": None
    }

    recs = DATA_CACHE.get("public_recommendations", [])
    recs.insert(0, new_rec)
    DATA_CACHE["public_recommendations"] = recs
    save_public_recommendations_to_disk()

    return jsonify({
        "status": "success",
        "message": f"Thank you, {reporter_name}! Your recommendation for {village} has been submitted to Command Center officers.",
        "recommendation": new_rec,
        "total": len(recs)
    })

@app.route("/api/officer/approve_recommendation/<rec_id>", methods=["POST"])
def approve_recommendation(rec_id):
    """
    Officer-only action: Approves a citizen recommendation and immediately deploys
    an official 108 ambulance base station at the recommended spot.
    """
    if not is_officer():
        return jsonify({
            "status": "error",
            "message": "🔒 Access Denied: Only Command Center Officers or Higher Authorities can approve recommendations and deploy emergency fleet."
        }), 403

    recs = DATA_CACHE.get("public_recommendations", [])
    target = None
    for r in recs:
        if r.get("id") == rec_id or r.get("rec_id") == rec_id:
            target = r
            break

    if not target:
        return jsonify({"status": "error", "message": f"Recommendation {rec_id} not found."}), 404

    # Create manual ambulance station based on citizen recommendation
    stn_id = f"APPR-108-{int(time.time()*1000)%100000}"
    new_stn = {
        "station_id": stn_id,
        "ambulance_id": stn_id,
        "name": f"{target['village']} Citizen-Recommended 108 Base",
        "district": target["district"],
        "mandal": target["mandal"],
        "lat": target["lat"],
        "lng": target["lng"],
        "allocated_vehicle_type": target.get("vehicle_type", "Advanced Life Support (ALS)"),
        "paramedic_crew": 3 if "ALS" in target.get("vehicle_type", "") else 2,
        "equipment": ["Ventilator", "Defibrillator", "Oxygen Cylinder", "Stretcher"] if "ALS" in target.get("vehicle_type", "") else ["Oxygen Cylinder", "First Aid Kit", "Stretcher"],
        "coverage_radius_km": 12.0,
        "is_manual": True,
        "is_from_recommendation": True,
        "recommended_by": target["reporter_name"],
        "created_at": int(time.time() * 1000)
    }

    # Add to active fleet and custom stations
    dispatch_engine.add_custom_station(new_stn)
    manual_list = DATA_CACHE.get("manual_ambulances", [])
    manual_list.insert(0, new_stn)
    DATA_CACHE["manual_ambulances"] = manual_list
    if "active_fleet" in DATA_CACHE:
        DATA_CACHE["active_fleet"].insert(0, new_stn)
    save_manual_ambulances_to_disk()

    # Update recommendation record
    user = get_current_user()
    approver = user.get("name") if user else "Command Center Officer"
    target["status"] = "Approved & Deployed"
    target["approved_station_id"] = stn_id
    target["officer_notes"] = f"Approved and deployed by {approver}."
    save_public_recommendations_to_disk()

    return jsonify({
        "status": "success",
        "message": f"Recommendation {rec_id} approved! 108 Base Station deployed at {target['village']}.",
        "recommendation": target,
        "station": new_stn
    })

@app.route("/api/officer/reject_recommendation/<rec_id>", methods=["POST"])
def reject_recommendation(rec_id):
    """Officer-only action: Rejects a recommendation with explanation."""
    if not is_officer():
        return jsonify({"status": "error", "message": "🔒 Access Denied: Officers only."}), 403

    data = request.get_json() or {}
    notes = data.get("notes") or data.get("review_notes") or "Reviewed by Command Center. Existing station coverage deemed sufficient."

    recs = DATA_CACHE.get("public_recommendations", [])
    for r in recs:
        if r.get("id") == rec_id or r.get("rec_id") == rec_id:
            r["status"] = "Rejected"
            r["officer_notes"] = notes
            save_public_recommendations_to_disk()
            return jsonify({
                "status": "success",
                "message": f"Recommendation {rec_id} rejected.",
                "recommendation": r
            })
    return jsonify({"status": "error", "message": f"Recommendation {rec_id} not found."}), 404

@app.route("/api/reported_accidents", methods=["GET"])
def get_reported_accidents():
    """Returns citizen-reported road accidents."""
    district = request.args.get("district", "ALL")
    accs = DATA_CACHE.get("reported_accidents", [])
    if district and district != "ALL":
        filtered = [a for a in accs if match_district(a.get("district", ""), district)]
    else:
        filtered = accs
    return jsonify({
        "status": "success",
        "total": len(filtered),
        "accidents": filtered
    })

@app.route("/api/public/report_accident", methods=["POST"])
def report_accident():
    """
    Public citizen endpoint to report an active road accident.
    Calculates nearest ambulance dispatch in real-time and logs the incident.
    """
    data = request.get_json() or {}
    user = get_current_user()

    reporter_name = data.get("reporter_name", "").strip() or data.get("caller_name", "").strip() or (user.get("name") if user else "Citizen Caller")
    reporter_phone = data.get("reporter_phone", "").strip() or data.get("caller_phone", "").strip() or (user.get("phone") if user else "+91 94401 00000")
    raw_lat = float(data.get("lat", 16.312))
    raw_lng = float(data.get("lng", 80.451))
    safe_lat = round(raw_lat, 5)
    safe_lng = clamp_to_ap_land(safe_lat, raw_lng)

    location_name = data.get("location_name", "").strip() or data.get("location_description", "").strip() or "Reported Crash Scene"
    district = data.get("district", "").strip()
    mandal = data.get("mandal", "").strip()

    if not mandal or not district:
        nearest_m = find_nearest_mandal(safe_lat, safe_lng)
        if nearest_m:
            mandal = mandal or nearest_m["mandal_name"]
            district = district or nearest_m["district"]

    severity = data.get("severity", "Critical")
    injured_count = int(data.get("injured_count", 1))
    landmark = data.get("landmark", "").strip()
    description = data.get("description", "").strip() or data.get("incident_description", "").strip()

    # Run dispatch engine to find nearest unit
    dispatch_res = dispatch_engine.dispatch_nearest_ambulance(safe_lat, safe_lng, severity=severity)

    acc_id = f"ACC-108-{int(time.time()*1000)%100000}"
    new_acc = {
        "id": acc_id,
        "accident_id": acc_id,
        "reporter_name": reporter_name,
        "caller_name": reporter_name,
        "reporter_phone": reporter_phone,
        "caller_phone": reporter_phone,
        "lat": safe_lat,
        "lng": safe_lng,
        "location_name": location_name,
        "location_description": location_name,
        "district": district,
        "mandal": mandal,
        "severity": severity,
        "injured_count": injured_count,
        "landmark": landmark,
        "description": description,
        "incident_description": description,
        "reported_at": time.strftime("%Y-%m-%d %H:%M"),
        "status": "dispatched",
        "dispatched_ambulance": dispatch_res["dispatched_ambulance"]["name"],
        "nearest_ambulance": dispatch_res["dispatched_ambulance"]["name"],
        "ambulance_id": dispatch_res["dispatched_ambulance"]["station_id"],
        "vehicle_type": dispatch_res["dispatched_ambulance"].get("allocated_vehicle_type", "ALS"),
        "eta_minutes": dispatch_res["response_metrics"]["estimated_eta_minutes"],
        "distance_km": dispatch_res["response_metrics"]["road_distance_km"]
    }

    accs = DATA_CACHE.get("reported_accidents", [])
    accs.insert(0, new_acc)
    DATA_CACHE["reported_accidents"] = accs
    save_reported_accidents_to_disk()

    return jsonify({
        "status": "success",
        "message": f"🚨 Accident logged! Nearest ambulance {new_acc['dispatched_ambulance']} dispatched with ETA {new_acc['eta_minutes']} min.",
        "accident": new_acc,
        "dispatch": dispatch_res,
        "total": len(accs)
    })

@app.route("/api/officer/resolve_accident/<accident_id>", methods=["POST"])
def resolve_accident(accident_id):
    """Officer-only action: Marks reported accident as resolved/cleared."""
    if not is_officer():
        return jsonify({"status": "error", "message": "🔒 Access Denied: Officers only."}), 403

    accs = DATA_CACHE.get("reported_accidents", [])
    for a in accs:
        if a.get("id") == accident_id or a.get("accident_id") == accident_id:
            a["status"] = "Resolved / Hospitalized"
            save_reported_accidents_to_disk()
            return jsonify({
                "status": "success",
                "message": f"Accident {accident_id} marked as resolved.",
                "accident": a
            })
    return jsonify({"status": "error", "message": f"Accident {accident_id} not found."}), 404

@app.route("/")
def index():
    """Renders the main Command Center dashboard."""
    district_names = [d["district_name"] for d in DATA_CACHE["districts"]]
    return render_template(
        "index.html",
        districts=sorted(district_names),
        total_districts=len(DATA_CACHE["districts"]),
        total_mandals=len(DATA_CACHE["mandals"]),
        total_villages=len(DATA_CACHE["villages"]),
        total_blackspots=len(DATA_CACHE["blackspots"]),
        baseline_ambulances_count=len(DATA_CACHE["baseline_ambulances"])
    )

@app.route("/api/districts", methods=["GET"])
def get_districts():
    """Returns all 26 Andhra Pradesh districts."""
    return jsonify({
        "status": "success",
        "total_districts": len(DATA_CACHE["districts"]),
        "districts": DATA_CACHE["districts"]
    })

def match_district(district1: str, district2: str) -> bool:
    """Case-insensitive and alias-resilient district matching."""
    if not district1 or not district2:
        return False
    aliases = {
        "nellore": "sps nellore",
        "sps nellore": "sps nellore",
        "sri potti sriramulu nellore": "sps nellore",
        "kadapa": "ysr kadapa",
        "ysr kadapa": "ysr kadapa",
        "ysr": "ysr kadapa",
        "konaseema": "dr. b.r. ambedkar konaseema",
        "dr. b.r. ambedkar konaseema": "dr. b.r. ambedkar konaseema",
        "manyam": "parvathipuram manyam",
        "parvathipuram manyam": "parvathipuram manyam",
        "alluri": "alluri sitharama raju",
        "asr": "alluri sitharama raju",
        "alluri sitharama raju": "alluri sitharama raju"
    }
    k1 = aliases.get(district1.strip().lower(), district1.strip().lower())
    k2 = aliases.get(district2.strip().lower(), district2.strip().lower())
    return k1 == k2

@app.route("/api/mandals", methods=["GET"])
def get_mandals():
    """Returns mandals filtered by district or all 679 mandals."""
    district = request.args.get("district", "ALL")
    if district and district != "ALL":
        filtered = [m for m in DATA_CACHE["mandals"] if match_district(m["district"], district)]
    else:
        filtered = DATA_CACHE["mandals"]
    return jsonify({
        "status": "success",
        "count": len(filtered),
        "district": district,
        "mandals": filtered
    })

@app.route("/api/blackspots", methods=["GET"])
def get_blackspots():
    """Returns accident blackspots filtered by district or all."""
    district = request.args.get("district", "ALL")
    if district and district != "ALL":
        filtered = [b for b in DATA_CACHE["blackspots"] if match_district(b["district"], district)]
    else:
        filtered = DATA_CACHE["blackspots"]
    return jsonify({
        "status": "success",
        "count": len(filtered),
        "district": district,
        "blackspots": filtered
    })

@app.route("/api/baseline", methods=["GET"])
def get_baseline_ambulances():
    """Returns baseline 108 ambulance deployment."""
    district = request.args.get("district", "ALL")
    if district and district != "ALL":
        filtered = [a for a in DATA_CACHE["baseline_ambulances"] if match_district(a["district"], district)]
    else:
        filtered = DATA_CACHE["baseline_ambulances"]
    return jsonify({
        "status": "success",
        "count": len(filtered),
        "ambulances": filtered
    })

@app.route("/api/trauma_centers", methods=["GET"])
def get_trauma_centers():
    """Returns major Apex and Regional Trauma Centers."""
    return jsonify({
        "status": "success",
        "trauma_centers": MAJOR_TRAUMA_CENTERS
    })

def compute_district_hull(points):
    """Computes 2D convex hull of coordinates for district boundary polygon."""
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]

@app.route("/api/district_details", methods=["GET"])
def get_district_details():
    """Returns total district summary, mandals, village counts, and perimeter hull."""
    district = request.args.get("district", "ALL")
    if not district or district == "ALL":
        return jsonify({
            "status": "success",
            "is_statewide": True,
            "total_districts": len(DATA_CACHE["districts"]),
            "total_mandals": len(DATA_CACHE["mandals"]),
            "total_villages": len(DATA_CACHE["villages"])
        })

    dist_info = next((d for d in DATA_CACHE["districts"] if match_district(d["district_name"], district)), None)
    mandals = [m for m in DATA_CACHE["mandals"] if match_district(m["district"], district)]
    villages = [v for v in DATA_CACHE["villages"] if match_district(v["district"], district)]
    blackspots = [b for b in DATA_CACHE["blackspots"] if match_district(b["district"], district)]
    baseline_ambs = [a for a in DATA_CACHE["baseline_ambulances"] if match_district(a["district"], district)]

    coords = [(v["lat"], v["lng"]) for v in villages] + [(m["lat"], m["lng"]) for m in mandals]
    hull = compute_district_hull(coords)

    mandal_stats = []
    for m in mandals:
        m_vils = [v for v in villages if v["mandal"].lower() == m["mandal_name"].lower()]
        mandal_stats.append({
            "mandal_id": m["mandal_id"],
            "mandal_name": m["mandal_name"],
            "lat": m["lat"],
            "lng": m["lng"],
            "population": m.get("population", 0),
            "tier": m.get("tier", "Rural"),
            "village_count": len(m_vils),
            "danger_spots_count": sum(1 for v in m_vils if "danger_spot" in v),
            "risk_score": m.get("risk_score", 5.0)
        })

    return jsonify({
        "status": "success",
        "is_statewide": False,
        "district": dist_info["district_name"] if dist_info else district,
        "headquarters": dist_info.get("headquarters", "") if dist_info else "",
        "lat": dist_info.get("lat", mandals[0]["lat"] if mandals else 0) if dist_info else 0,
        "lng": dist_info.get("lng", mandals[0]["lng"] if mandals else 0) if dist_info else 0,
        "highways": dist_info.get("highways", []) if dist_info else [],
        "total_mandals": len(mandals),
        "total_villages": len(villages),
        "total_danger_spots": sum(1 for v in villages if "danger_spot" in v),
        "total_blackspots": len(blackspots),
        "total_baseline_ambulances": len(baseline_ambs),
        "boundary_hull": hull,
        "mandals": mandal_stats
    })

@app.route("/api/villages", methods=["GET"])
def get_villages():
    """Returns villages filtered by district and optional mandal."""
    district = request.args.get("district", "ALL")
    mandal = request.args.get("mandal", "ALL")
    default_limit = 10000 if (district and district != "ALL") else 2500
    limit = int(request.args.get("limit", default_limit))

    villages = DATA_CACHE.get("villages", [])
    if district and district != "ALL":
        villages = [v for v in villages if match_district(v["district"], district)]
    if mandal and mandal != "ALL":
        villages = [v for v in villages if v["mandal"].lower() == mandal.lower()]

    return jsonify({
        "status": "success",
        "total": len(villages),
        "district": district,
        "mandal": mandal,
        "villages": villages[:limit]
    })

@app.route("/api/search_village", methods=["GET"])
def search_village():
    """Autocomplete search for any village in Andhra Pradesh by name."""
    query = request.args.get("q", "").strip().lower()
    if not query or len(query) < 2:
        return jsonify({"status": "success", "results": []})

    results = []
    for v in DATA_CACHE.get("villages", []):
        if query in v["village_name"].lower() or query in v["mandal"].lower():
            results.append({
                "village_id": v["village_id"],
                "village_name": v["village_name"],
                "mandal": v["mandal"],
                "district": v["district"],
                "lat": v["lat"],
                "lng": v["lng"],
                "population": v["population"],
                "gram_panchayat": v.get("gram_panchayat", ""),
                "has_phc": v.get("has_phc", False),
                "label": f"{v['village_name']} ({v['mandal']} Mdl, {v['district']} Dt)"
            })
            if len(results) >= 25:
                break

    return jsonify({
        "status": "success",
        "query": query,
        "results": results
    })

@app.route("/api/optimize", methods=["POST"])
def optimize_positioning():
    """
    Solves ambulance positioning using MCLP, p-Median, or Hybrid model.
    JSON payload:
    {
        "district": "Guntur" or "ALL",
        "num_ambulances": 14,
        "radius_km": 12.0,
        "algorithm": "mclp" | "p_median" | "hybrid"
    }
    """
    data = request.get_json() or {}
    district = data.get("district", "ALL")
    num_ambulances = int(data.get("num_ambulances", 12))
    radius_km = float(data.get("radius_km", 12.0))
    algorithm = data.get("algorithm", "hybrid").lower()

    # Filter demand points (mandals + blackspots) and candidate sites
    if district and district != "ALL":
        mandals = [m for m in DATA_CACHE["mandals"] if match_district(m["district"], district)]
        blackspots = [b for b in DATA_CACHE["blackspots"] if match_district(b["district"], district)]
    else:
        mandals = DATA_CACHE["mandals"]
        blackspots = DATA_CACHE["blackspots"]

    # Format demand points: combine mandal centroids and highway blackspots
    demand_points = []
    for m in mandals:
        demand_points.append({
            "id": m["mandal_id"],
            "name": f"{m['mandal_name']} Mandal HQ",
            "lat": m["lat"],
            "lng": m["lng"],
            "weight": m.get("demand_weight", 1.0),
            "type": "Mandal Node"
        })

    for b in blackspots:
        demand_points.append({
            "id": b["blackspot_id"],
            "name": b["location_name"],
            "lat": b["lat"],
            "lng": b["lng"],
            "weight": b.get("weight", 2.0),
            "type": "Accident Blackspot"
        })

    # Candidate sites: all mandal headquarters and major highway nodal intersections
    candidate_sites = []
    for m in mandals:
        candidate_sites.append({
            "id": f"CAND-{m['mandal_id']}",
            "name": f"{m['mandal_name']} CHC/Base",
            "lat": m["lat"],
            "lng": m["lng"],
            "mandal": m["mandal_name"],
            "district": m["district"]
        })

    # Run optimizer
    hybrid_opt = HybridAmbulanceOptimizer(demand_points, candidate_sites, radius_km)
    p_alloc = min(num_ambulances, len(candidate_sites))
    opt_result = hybrid_opt.optimize(p_ambulances=p_alloc, mode=algorithm)

    # For the selected district, generate ready stations for ALL mandals so NO village is left uncovered!
    selected_mandals = {stn["mandal"].lower() for stn in opt_result["selected_stations"]}
    ready_stations = []
    for m in mandals:
        if m["mandal_name"].lower() not in selected_mandals:
            ready_stations.append({
                "station_id": f"READY-{m['mandal_id']}",
                "name": f"{m['mandal_name']} 108 Ready Emergency Station",
                "lat": m["lat"],
                "lng": m["lng"],
                "district": m["district"],
                "mandal": m["mandal_name"],
                "allocated_vehicle_type": "Basic Life Support (BLS) - Ready Post",
                "paramedic_crew": 2,
                "equipment": ["Oxygen Cylinder", "First Aid Kit", "Stretcher", "Suction Unit"],
                "is_ready_station": True,
                "coverage_radius_km": radius_km
            })

    opt_result["ready_mandal_stations"] = ready_stations

    # Update active fleet in cache and dispatch engine:
    # Combine manual custom stations + selected priority ALS stations + all complementary ready mandal stations!
    active_fleet = []
    # 1. Custom manually placed ambulances have highest priority
    for stn in DATA_CACHE.get("manual_ambulances", []):
        active_fleet.append({
            "ambulance_id": stn["station_id"],
            "name": stn["name"],
            "lat": stn["lat"],
            "lng": stn["lng"],
            "district": stn.get("district", ""),
            "mandal": stn.get("mandal", ""),
            "allocated_vehicle_type": stn.get("allocated_vehicle_type", "Advanced Life Support (ALS)"),
            "is_manual": True
        })

    for stn in opt_result["selected_stations"]:
        active_fleet.append({
            "ambulance_id": stn["station_id"],
            "name": stn["name"],
            "lat": stn["lat"],
            "lng": stn["lng"],
            "district": stn["district"],
            "mandal": stn["mandal"],
            "allocated_vehicle_type": stn.get("allocated_vehicle_type", "Advanced Life Support (ALS)")
        })
    for stn in ready_stations:
        active_fleet.append({
            "ambulance_id": stn["station_id"],
            "name": stn["name"],
            "lat": stn["lat"],
            "lng": stn["lng"],
            "district": stn["district"],
            "mandal": stn["mandal"],
            "allocated_vehicle_type": stn.get("allocated_vehicle_type", "Basic Life Support (BLS)")
        })

    DATA_CACHE["active_fleet"] = active_fleet
    dispatch_engine.update_fleet(active_fleet)
    dispatch_engine.set_custom_stations(DATA_CACHE.get("manual_ambulances", []))
    opt_result["manual_stations"] = DATA_CACHE.get("manual_ambulances", [])

    # Run comparative evaluation against baseline
    evaluator = GoldenHourEvaluator(mandals, blackspots)
    base_fleet_district = [
        a for a in DATA_CACHE["baseline_ambulances"]
        if district == "ALL" or match_district(a["district"], district)
    ]
    comparison = evaluator.compare(base_fleet_district, active_fleet)

    return jsonify({
        "status": "success",
        "district": district,
        "optimization": opt_result,
        "evaluation": comparison
    })

def save_manual_ambulances_to_disk():
    """Persists all manually placed ambulances to data/ap_manual_ambulances.json."""
    man_path = os.path.join(DATA_DIR, "ap_manual_ambulances.json")
    try:
        with open(man_path, "w", encoding="utf-8") as f:
            json.dump(DATA_CACHE.get("manual_ambulances", []), f, indent=2)
    except Exception as e:
        print(f"Error saving manual ambulances: {e}")

def find_nearest_mandal(lat: float, lng: float):
    """Finds the closest mandal for any given coordinates."""
    best_mandal = None
    min_d = float("inf")
    for m in DATA_CACHE.get("mandals", []):
        d = (m["lat"] - lat)**2 + (m["lng"] - lng)**2
        if d < min_d:
            min_d = d
            best_mandal = m
    return best_mandal

@app.route("/api/manual_ambulances", methods=["GET"])
def get_manual_ambulances():
    """Returns all saved manually placed 108 ambulances."""
    district = request.args.get("district", "ALL")
    manual_ambs = DATA_CACHE.get("manual_ambulances", [])
    if district and district != "ALL":
        filtered = [a for a in manual_ambs if match_district(a.get("district", ""), district)]
    else:
        filtered = manual_ambs

    return jsonify({
        "status": "success",
        "total": len(filtered),
        "district": district,
        "ambulances": filtered
    })

@app.route("/api/manual_ambulances", methods=["POST"])
def add_manual_ambulance():
    """
    Permanently saves a manually placed 108 ambulance to disk and registers in active fleet.
    Restricted to Command Center Officers and Higher Health Authorities.
    """
    if not is_officer():
        return jsonify({
            "status": "error",
            "error": "unauthorized",
            "message": "🔒 Access Denied: Manual ambulance positioning is restricted to Command Center Officers and Higher Authorities. As a public citizen, please submit a recommendation instead."
        }), 403

    data = request.get_json() or {}
    raw_lat = float(data.get("lat", 16.312))
    raw_lng = float(data.get("lng", 80.451))
    safe_lat = round(raw_lat, 5)
    safe_lng = clamp_to_ap_land(safe_lat, raw_lng)

    mandal = data.get("mandal", "").strip()
    district = data.get("district", "").strip()

    # Automatically resolve nearest mandal and district if missing or generic
    if not mandal or mandal in ["Local", "General", ""] or not district or district in ["General", ""]:
        nearest_m = find_nearest_mandal(safe_lat, safe_lng)
        if nearest_m:
            mandal = nearest_m["mandal_name"]
            district = nearest_m["district"]
        else:
            mandal = mandal or "Local Mandal"
            district = district or "Andhra Pradesh"

    custom_name = data.get("name", "").strip()
    if not custom_name:
        custom_name = f"{mandal} Custom 108 Base Station"

    vehicle_type = data.get("vehicle_type", "Advanced Life Support (ALS) - Custom Base")
    radius_km = float(data.get("radius_km", 12.0))
    station_id = f"MANUAL-108-{int(time.time()*1000)%1000000}"

    new_stn = {
        "station_id": station_id,
        "ambulance_id": station_id,
        "name": custom_name,
        "district": district,
        "mandal": mandal,
        "lat": safe_lat,
        "lng": safe_lng,
        "allocated_vehicle_type": vehicle_type,
        "paramedic_crew": 3 if "ALS" in vehicle_type else 2,
        "equipment": ["Ventilator", "Defibrillator", "Oxygen Cylinder", "Stretcher", "Suction Unit"] if "ALS" in vehicle_type else ["Oxygen Cylinder", "First Aid Kit", "Stretcher"],
        "coverage_radius_km": radius_km,
        "is_manual": True,
        "created_at": int(time.time() * 1000)
    }

    # Store in memory cache
    manual_list = DATA_CACHE.get("manual_ambulances", [])
    # Replace existing station if same coordinates or ID
    manual_list = [s for s in manual_list if s.get("station_id") != station_id]
    manual_list.insert(0, new_stn)
    DATA_CACHE["manual_ambulances"] = manual_list

    # Update active fleet
    if "active_fleet" in DATA_CACHE:
        DATA_CACHE["active_fleet"] = [s for s in DATA_CACHE["active_fleet"] if s.get("station_id") != station_id]
        DATA_CACHE["active_fleet"].insert(0, new_stn)

    # Register into live dispatch engine
    dispatch_engine.add_custom_station(new_stn)

    # Save permanently to disk
    save_manual_ambulances_to_disk()

    return jsonify({
        "status": "success",
        "message": f"108 Ambulance permanently stationed at {custom_name}!",
        "ambulance": new_stn,
        "total_manual": len(manual_list)
    })

@app.route("/api/manual_ambulances/<station_id>", methods=["DELETE"])
def delete_manual_ambulance(station_id):
    """Permanently deletes a manually placed ambulance from disk and memory. Restricted to Officers."""
    if not is_officer():
        return jsonify({
            "status": "error",
            "error": "unauthorized",
            "message": "🔒 Access Denied: Deleting manual ambulance positions is restricted to Command Center Officers and Higher Authorities."
        }), 403

    manual_list = DATA_CACHE.get("manual_ambulances", [])
    initial_len = len(manual_list)
    updated_list = [s for s in manual_list if s.get("station_id") != station_id and s.get("ambulance_id") != station_id]

    if len(updated_list) == initial_len:
        return jsonify({
            "status": "error",
            "message": f"Ambulance station {station_id} not found."
        }), 404

    DATA_CACHE["manual_ambulances"] = updated_list
    if "active_fleet" in DATA_CACHE:
        DATA_CACHE["active_fleet"] = [s for s in DATA_CACHE["active_fleet"] if s.get("station_id") != station_id and s.get("ambulance_id") != station_id]

    dispatch_engine.remove_custom_station(station_id)
    save_manual_ambulances_to_disk()

    return jsonify({
        "status": "success",
        "message": f"Ambulance station {station_id} deleted permanently.",
        "total_manual": len(updated_list)
    })

@app.route("/api/dispatch", methods=["POST"])
def dispatch_incident():
    """
    Simulates real-time accident dispatch.
    JSON payload:
    {
        "lat": 16.312,
        "lng": 80.451,
        "severity": "Critical"
    }
    """
    data = request.get_json() or {}
    lat = float(data.get("lat", 16.312))
    lng = float(data.get("lng", 80.451))
    severity = data.get("severity", "Critical")

    dispatch_res = dispatch_engine.dispatch_nearest_ambulance(lat, lng, severity)
    return jsonify({
        "status": "success",
        "dispatch": dispatch_res
    })

@app.route("/api/place_ambulance_nearer", methods=["POST"])
def place_ambulance_nearer():
    """
    Positions a Rapid Response 108 Ambulance right at or near
    a village or danger spot to immediately reduce response time and save the Golden Hour.
    Permanently persists the station so it never disappears on refresh.
    Restricted to Command Center Officers and Higher Authorities.
    """
    if not is_officer():
        return jsonify({
            "status": "error",
            "error": "unauthorized",
            "message": "🔒 Access Denied: Placing emergency ambulances on-demand is restricted to Command Center Officers and Higher Authorities. As a citizen, you can recommend this position for officer approval."
        }), 403

    data = request.get_json() or {}
    raw_lat = float(data.get("lat", 16.312))
    raw_lng = float(data.get("lng", 80.451))
    safe_lat = round(raw_lat, 5)
    safe_lng = clamp_to_ap_land(safe_lat, raw_lng)

    location_name = data.get("location_name", "Village Danger Spot")
    district = data.get("district", "General")
    mandal = data.get("mandal", "Local")

    if not mandal or mandal in ["Local", "General"] or not district or district in ["General"]:
        nearest_m = find_nearest_mandal(safe_lat, safe_lng)
        if nearest_m:
            mandal = nearest_m["mandal_name"]
            district = nearest_m["district"]

    stn_id = f"RAPID-108-{int(time.time()*1000)%100000}"
    new_stn = {
        "station_id": stn_id,
        "ambulance_id": stn_id,
        "name": f"{location_name} Rapid 108 Post",
        "district": district,
        "mandal": mandal,
        "lat": safe_lat,
        "lng": safe_lng,
        "allocated_vehicle_type": "Advanced Life Support (ALS) - Rapid Post",
        "paramedic_crew": 3,
        "equipment": ["Ventilator", "Defibrillator", "Oxygen Cylinder", "Stretcher", "Suction Unit"],
        "coverage_radius_km": 12.0,
        "is_custom_nearer": True,
        "is_manual": True,
        "created_at": int(time.time() * 1000)
    }

    # Add to custom stations and save persistently
    dispatch_engine.add_custom_station(new_stn)
    manual_list = DATA_CACHE.get("manual_ambulances", [])
    manual_list = [s for s in manual_list if s.get("station_id") != stn_id]
    manual_list.insert(0, new_stn)
    DATA_CACHE["manual_ambulances"] = manual_list

    if "active_fleet" in DATA_CACHE:
        DATA_CACHE["active_fleet"].insert(0, new_stn)

    save_manual_ambulances_to_disk()

    # Immediately re-run dispatch for this spot
    dispatch_res = dispatch_engine.dispatch_nearest_ambulance(safe_lat, safe_lng, severity="Critical")

    return jsonify({
        "status": "success",
        "station": new_stn,
        "dispatch": dispatch_res,
        "total_manual": len(manual_list),
        "message": f"Rapid 108 Ambulance stationed permanently at {location_name}!"
    })

@app.route("/api/village_danger_spots", methods=["GET"])
def get_village_danger_spots():
    """Returns danger spots for villages filtered by district."""
    district = request.args.get("district", "ALL")
    default_limit = 10000 if (district and district != "ALL") else 2500
    limit = int(request.args.get("limit", default_limit))
    villages = DATA_CACHE.get("villages", [])
    if district and district != "ALL":
        villages = [v for v in villages if match_district(v["district"], district)]

    danger_spots = []
    for v in villages[:limit]:
        if "danger_spot" in v:
            ds = dict(v["danger_spot"])
            ds["village_id"] = v.get("village_id")
            ds["village_name"] = v.get("village_name")
            ds["mandal"] = v.get("mandal")
            ds["district"] = v.get("district")
            ds["population"] = v.get("population")
            danger_spots.append(ds)

    return jsonify({
        "status": "success",
        "total": len(danger_spots),
        "district": district,
        "danger_spots": danger_spots
    })

@app.route("/api/export_report", methods=["GET"])
def export_report():
    """Exports the current optimal station recommendations as a CSV file."""
    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "Station ID", "Station Name", "District", "Mandal", "Latitude", "Longitude",
        "Vehicle Type", "Paramedics", "Equipment", "Covered Demands Count"
    ])

    for stn in DATA_CACHE["active_fleet"]:
        writer.writerow([
            stn.get("ambulance_id", ""),
            stn.get("name", ""),
            stn.get("district", ""),
            stn.get("mandal", ""),
            stn.get("lat", ""),
            stn.get("lng", ""),
            stn.get("allocated_vehicle_type", "Basic Life Support (BLS)"),
            3 if "ALS" in stn.get("allocated_vehicle_type", "") else 2,
            "Ventilator, Defibrillator, Cardiac Monitor" if "ALS" in stn.get("allocated_vehicle_type", "") else "Oxygen, First Aid Kit, Stretcher",
            stn.get("covered_demand_count", "N/A")
        ])

    output.seek(0)
    return send_file(
        io.BytesIO(output.getvalue().encode("utf-8")),
        mimetype="text/csv",
        as_attachment=True,
        download_name="AP_Optimal_Ambulance_Recommendations.csv"
    )

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"Starting AP Ambulance Optimizer Web Command Center on http://127.0.0.1:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
