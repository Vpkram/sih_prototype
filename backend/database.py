import sqlite3
import os
from datetime import datetime, timedelta
import random

DB_PATH = os.path.join(os.path.dirname(__file__), "sih_prototype.db")

DEFAULT_CAMERAS = [
    {
        "camera_id": "camera_1",
        "name": "Silk Board Junction (Cam 1)",
        "lat": 12.9172,
        "lng": 77.6228,
        "status": "Active"
    },
    {
        "camera_id": "camera_2",
        "name": "HSR Layout 27th Main (Cam 2)",
        "lat": 12.9116,
        "lng": 77.6444,
        "status": "Active"
    },
    {
        "camera_id": "camera_3",
        "name": "Koramangala Sony World (Cam 3)",
        "lat": 12.9345,
        "lng": 77.6242,
        "status": "Active"
    },
    {
        "camera_id": "camera_4",
        "name": "Indiranagar 100ft Road (Cam 4)",
        "lat": 12.9784,
        "lng": 77.6408,
        "status": "Active"
    },
    {
        "camera_id": "camera_5",
        "name": "MG Road Metro Station (Cam 5)",
        "lat": 12.9756,
        "lng": 77.6066,
        "status": "Active"
    }
]

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    
    # Create cameras table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS cameras (
            camera_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            status TEXT DEFAULT 'Active'
        )
    """)
    
    # Create detections table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS detections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plate_number TEXT NOT NULL,
            camera_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            confidence REAL DEFAULT 0.95,
            crop_path TEXT DEFAULT '',
            lat REAL,
            lng REAL,
            FOREIGN KEY (camera_id) REFERENCES cameras (camera_id)
        )
    """)
    
    # Create blacklist table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS blacklist (
            plate_number TEXT PRIMARY KEY,
            reason TEXT NOT NULL,
            added_at TEXT NOT NULL
        )
    """)
    
    # Create alerts table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plate_number TEXT NOT NULL,
            camera_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            alert_type TEXT NOT NULL,
            message TEXT NOT NULL,
            acknowledged INTEGER DEFAULT 0,
            FOREIGN KEY (camera_id) REFERENCES cameras (camera_id)
        )
    """)
    
    conn.commit()
    
    # Insert default cameras if not present
    for cam in DEFAULT_CAMERAS:
        cursor.execute("""
            INSERT OR IGNORE INTO cameras (camera_id, name, lat, lng, status)
            VALUES (?, ?, ?, ?, ?)
        """, (cam["camera_id"], cam["name"], cam["lat"], cam["lng"], cam["status"]))
        
    conn.commit()
    conn.close()

def add_blacklist_plate(plate_number: str, reason: str = "Flagged by Law Enforcement"):
    clean_plate = "".join([c for c in plate_number.upper() if c.isalnum()])
    if not clean_plate:
        return None
        
    clean_reason = reason.strip() if (reason and isinstance(reason, str) and reason.strip()) else "No reason provided"
        
    conn = get_connection()
    cursor = conn.cursor()
    added_at = datetime.now().isoformat()
    
    cursor.execute("""
        INSERT OR REPLACE INTO blacklist (plate_number, reason, added_at)
        VALUES (?, ?, ?)
    """, (clean_plate, clean_reason, added_at))
    conn.commit()
    
    # Check existing detections to generate retrospective alerts if plate was seen recently
    cursor.execute("""
        SELECT camera_id, timestamp FROM detections 
        WHERE plate_number = ? 
        ORDER BY timestamp DESC LIMIT 3
    """, (clean_plate,))
    past_detections = cursor.fetchall()
    
    for det in past_detections:
        cursor.execute("""
            INSERT INTO alerts (plate_number, camera_id, timestamp, alert_type, message, acknowledged)
            VALUES (?, ?, ?, 'blacklisted_vehicle', ?, 0)
        """, (clean_plate, det["camera_id"], det["timestamp"], f"Blacklisted Vehicle: {clean_reason}"))
        
    conn.commit()
    conn.close()
    return {"plate_number": clean_plate, "reason": clean_reason, "added_at": added_at}

def get_blacklist():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM blacklist ORDER BY added_at DESC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

LAST_SUSPICIOUS_ALERT_TIME = None
LAST_BLACKLIST_ALERT_TIME = {}

def check_and_trigger_alerts(plate_number: str, camera_id: str, timestamp_str: str):
    global LAST_SUSPICIOUS_ALERT_TIME, LAST_BLACKLIST_ALERT_TIME
    conn = get_connection()
    cursor = conn.cursor()
    
    curr_dt = datetime.now()
    try:
        curr_dt = datetime.fromisoformat(timestamp_str)
    except Exception:
        pass
    
    # 1. Blacklist Alert Check (Throttled to max 1 alert per plate every 45s)
    cursor.execute("SELECT reason FROM blacklist WHERE plate_number = ?", (plate_number,))
    bl_row = cursor.fetchone()
    if bl_row:
        raw_reason = bl_row["reason"]
        clean_reason = raw_reason.strip() if (raw_reason and isinstance(raw_reason, str) and raw_reason.strip()) else "No reason provided"
        
        last_t = LAST_BLACKLIST_ALERT_TIME.get(plate_number)
        if not last_t or (curr_dt - last_t).total_seconds() >= 45:
            LAST_BLACKLIST_ALERT_TIME[plate_number] = curr_dt
            cursor.execute("""
                INSERT INTO alerts (plate_number, camera_id, timestamp, alert_type, message, acknowledged)
                VALUES (?, ?, ?, 'blacklisted_vehicle', ?, 0)
            """, (plate_number, camera_id, timestamp_str, f"Blacklisted Vehicle: {clean_reason}"))
            conn.commit()
        
    # 2. Suspicious Route Alert Check (3+ distinct cameras in <= 10 minutes window, throttled to max 1 alert per 60s)
    try:
        window_start = (curr_dt - timedelta(minutes=10)).isoformat()
        
        cursor.execute("""
            SELECT COUNT(DISTINCT camera_id) as cam_count
            FROM detections
            WHERE plate_number = ? AND timestamp >= ?
        """, (plate_number, window_start))
        
        res = cursor.fetchone()
        distinct_cams = res["cam_count"] if res else 0
        
        if distinct_cams >= 3:
            if not LAST_SUSPICIOUS_ALERT_TIME or (curr_dt - LAST_SUSPICIOUS_ALERT_TIME).total_seconds() >= 60:
                LAST_SUSPICIOUS_ALERT_TIME = curr_dt
                msg = f"Suspicious Route: Vehicle crossed {distinct_cams} different cameras in <10 mins."
                cursor.execute("""
                    INSERT INTO alerts (plate_number, camera_id, timestamp, alert_type, message, acknowledged)
                    VALUES (?, ?, ?, 'suspicious_route', ?, 0)
                """, (plate_number, camera_id, timestamp_str, msg))
                conn.commit()
    except Exception as e:
        pass

    conn.close()

def add_detection(plate_number: str, camera_id: str, timestamp: str = None, confidence: float = 0.95, crop_path: str = ""):
    conn = get_connection()
    cursor = conn.cursor()
    
    # Clean plate number: uppercase, remove spaces/hyphens
    clean_plate = "".join([c for c in plate_number.upper() if c.isalnum()])
    if not clean_plate:
        conn.close()
        return None
        
    if not timestamp:
        timestamp = datetime.now().isoformat()
        
    # Get camera coordinates
    cursor.execute("SELECT lat, lng FROM cameras WHERE camera_id = ?", (camera_id,))
    cam = cursor.fetchone()
    lat = cam["lat"] if cam else 12.9716
    lng = cam["lng"] if cam else 77.5946
    
    cursor.execute("""
        INSERT INTO detections (plate_number, camera_id, timestamp, confidence, crop_path, lat, lng)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (clean_plate, camera_id, timestamp, confidence, crop_path, lat, lng))
    
    detection_id = cursor.lastrowid
    conn.commit()
    conn.close()
    
    # Trigger intelligent alert checks
    check_and_trigger_alerts(clean_plate, camera_id, timestamp)
    
    return {
        "id": detection_id,
        "plate_number": clean_plate,
        "camera_id": camera_id,
        "timestamp": timestamp,
        "confidence": confidence,
        "crop_path": crop_path,
        "lat": lat,
        "lng": lng
    }

def get_trajectory(plate_number: str):
    conn = get_connection()
    cursor = conn.cursor()
    clean_plate = "".join([c for c in plate_number.upper() if c.isalnum()])
    
    cursor.execute("""
        SELECT d.id, d.plate_number, d.camera_id, d.timestamp, d.confidence, d.crop_path, d.lat, d.lng, c.name as camera_name
        FROM detections d
        LEFT JOIN cameras c ON d.camera_id = c.camera_id
        WHERE d.plate_number = ?
        ORDER BY d.timestamp ASC
    """, (clean_plate,))
    
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_recent_events(limit: int = 50):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT d.id, d.plate_number, d.camera_id, d.timestamp, d.confidence, d.crop_path, d.lat, d.lng, c.name as camera_name
        FROM detections d
        LEFT JOIN cameras c ON d.camera_id = c.camera_id
        ORDER BY d.timestamp DESC
        LIMIT ?
    """, (limit,))
    
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_cameras():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM cameras ORDER BY camera_id ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_alerts(limit: int = 50):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT a.id, a.plate_number, a.camera_id, a.timestamp, a.alert_type, a.message, a.acknowledged, c.name as camera_name
        FROM alerts a
        LEFT JOIN cameras c ON a.camera_id = c.camera_id
        ORDER BY a.timestamp DESC
        LIMIT ?
    """, (limit,))
    rows = cursor.fetchall()
    
    cursor.execute("SELECT COUNT(*) as unack FROM alerts WHERE acknowledged = 0")
    unack_count = cursor.fetchone()["unack"]
    
    conn.close()
    return {"unacknowledged_count": unack_count, "alerts": [dict(row) for row in rows]}

def acknowledge_alerts():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0")
    conn.commit()
    conn.close()
    return {"success": True, "message": "All alerts acknowledged."}

def seed_mock_data(force: bool = False):
    init_db()
    conn = get_connection()
    cursor = conn.cursor()
    
    if force:
        # Reset existing tables for clean demo state
        cursor.execute("DELETE FROM detections")
        cursor.execute("DELETE FROM alerts")
        cursor.execute("DELETE FROM blacklist")
        conn.commit()
    else:
        cursor.execute("SELECT COUNT(*) as cnt FROM detections")
        if cursor.fetchone()["cnt"] > 0:
            conn.close()
            return "Database already contains detections."

    # Every sample plate gets at least 5 camera detections with staggered timestamps
    sample_routes = {
        "KA01AB1234": ["camera_1", "camera_2", "camera_3", "camera_4", "camera_5"],
        "KA05MH8899": ["camera_5", "camera_3", "camera_2", "camera_1", "camera_4"],
        "DL03CC4567": ["camera_2", "camera_1", "camera_3", "camera_4", "camera_5"],
        "MH12DE9012": ["camera_4", "camera_2", "camera_1", "camera_3", "camera_5"],
        "TS07FA5511": ["camera_1", "camera_3", "camera_2", "camera_5", "camera_4"],
        "TN09BK7788": ["camera_3", "camera_1", "camera_4", "camera_2", "camera_5"],
        "HR26DQ1122": ["camera_5", "camera_4", "camera_3", "camera_1", "camera_2"]
    }
    
    now = datetime.now()
    
    for plate, route in sample_routes.items():
        base_time = now - timedelta(hours=2)
        for i, cam_id in enumerate(route):
            t_str = (base_time + timedelta(minutes=i * 20 + random.randint(1, 4))).isoformat()
            add_detection(plate, cam_id, timestamp=t_str, confidence=0.96)
            
    # Mark all initial background seeded alerts as acknowledged so demo starts clean with 0 unread alerts
    cursor.execute("UPDATE alerts SET acknowledged = 1")
    conn.commit()
    conn.close()
        
    return "Seeded sample trajectories for all plates and reset unread alerts to 0."

def reset_demo_environment():
    init_db()
    conn = get_connection()
    cursor = conn.cursor()
    
    # 1. Clear detections, alerts, and blacklist
    cursor.execute("DELETE FROM detections")
    cursor.execute("DELETE FROM alerts")
    cursor.execute("DELETE FROM blacklist")
    conn.commit()
    
    # 2. Seed clean multi-camera trajectories for all sample plates
    sample_routes = {
        "KA01AB1234": ["camera_1", "camera_2", "camera_3", "camera_4", "camera_5"],
        "KA05MH8899": ["camera_5", "camera_3", "camera_2", "camera_1", "camera_4"],
        "DL03CC4567": ["camera_2", "camera_1", "camera_3", "camera_4", "camera_5"],
        "MH12DE9012": ["camera_4", "camera_2", "camera_1", "camera_3", "camera_5"],
        "TS07FA5511": ["camera_1", "camera_3", "camera_2", "camera_5", "camera_4"],
        "TN09BK7788": ["camera_3", "camera_1", "camera_4", "camera_2", "camera_5"],
        "HR26DQ1122": ["camera_5", "camera_4", "camera_3", "camera_1", "camera_2"]
    }
    
    now = datetime.now()
    
    for plate, route in sample_routes.items():
        base_time = now - timedelta(hours=2)
        for i, cam_id in enumerate(route):
            t_str = (base_time + timedelta(minutes=i * 20 + random.randint(1, 4))).isoformat()
            cursor.execute("SELECT lat, lng FROM cameras WHERE camera_id = ?", (cam_id,))
            cam = cursor.fetchone()
            lat = cam["lat"] if cam else 12.9716
            lng = cam["lng"] if cam else 77.5946
            
            cursor.execute("""
                INSERT INTO detections (plate_number, camera_id, timestamp, confidence, crop_path, lat, lng)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (plate, cam_id, t_str, 0.96, "", lat, lng))
            
    conn.commit()
    cursor.execute("DELETE FROM alerts")
    conn.commit()
    conn.close()
    
    return "Demo environment reset: seeded clean trajectories and reset unread alerts to 0."


import math

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculates Earth distance in kilometers between two lat/lng coordinates."""
    R = 6371.0  # Earth radius in kilometers
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2.0)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2.0)**2
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c

def get_analytics_data():
    """Computes camera traffic densities, heatmap coordinates, average speed, and route flows."""
    conn = get_connection()
    cursor = conn.cursor()
    
    # 1. Camera Density and Heatmap
    cursor.execute("""
        SELECT c.camera_id, c.name, c.lat, c.lng, COUNT(d.id) as detection_count
        FROM cameras c
        LEFT JOIN detections d ON c.camera_id = d.camera_id
        GROUP BY c.camera_id
        ORDER BY c.camera_id ASC
    """)
    cameras_summary = [dict(row) for row in cursor.fetchall()]
    
    max_count = max([c["detection_count"] for c in cameras_summary] or [1])
    max_count = max(max_count, 1)
    
    heatmap_points = []
    for c in cameras_summary:
        intensity = round(c["detection_count"] / max_count, 2)
        heatmap_points.append([c["lat"], c["lng"], max(intensity, 0.2)])
        
    # 2. Trajectories, Speed Estimation, and Route Flow Analysis
    cursor.execute("""
        SELECT d.plate_number, d.camera_id, d.timestamp, d.lat, d.lng, c.name as camera_name
        FROM detections d
        LEFT JOIN cameras c ON d.camera_id = c.camera_id
        ORDER BY d.plate_number, d.timestamp ASC
    """)
    all_detections = [dict(row) for row in cursor.fetchall()]
    
    # Group by plate
    plates_map = {}
    for d in all_detections:
        p = d["plate_number"]
        if p not in plates_map:
            plates_map[p] = []
        plates_map[p].append(d)
        
    calculated_speeds = []
    transitions_map = {} # (from_cam, to_cam) -> {'count': 0, 'total_mins': 0, 'from_name': '', 'to_name': ''}
    
    for plate, trajectory in plates_map.items():
        for i in range(len(trajectory) - 1):
            t1_obj = trajectory[i]
            t2_obj = trajectory[i + 1]
            
            # Skip if same camera consecutive hit
            if t1_obj["camera_id"] == t2_obj["camera_id"]:
                continue
                
            try:
                dt1 = datetime.fromisoformat(t1_obj["timestamp"])
                dt2 = datetime.fromisoformat(t2_obj["timestamp"])
                diff_seconds = (dt2 - dt1).total_seconds()
                
                if diff_seconds > 0:
                    diff_hours = diff_seconds / 3600.0
                    dist_km = haversine_distance(t1_obj["lat"], t1_obj["lng"], t2_obj["lat"], t2_obj["lng"])
                    speed = dist_km / diff_hours
                    
                    # Store valid speed estimates (1 km/h to 150 km/h)
                    if 1.0 <= speed <= 150.0:
                        calculated_speeds.append(speed)
                    else:
                        # Fallback realistic speed estimate based on urban distance
                        calculated_speeds.append(min(max(dist_km / (diff_seconds / 3600.0), 25.0), 65.0))
                        
                    # Route transition tracking
                    key = (t1_obj["camera_id"], t2_obj["camera_id"])
                    if key not in transitions_map:
                        transitions_map[key] = {
                            "from_camera_id": t1_obj["camera_id"],
                            "from_camera_name": t1_obj["camera_name"],
                            "to_camera_id": t2_obj["camera_id"],
                            "to_camera_name": t2_obj["camera_name"],
                            "count": 0,
                            "total_mins": 0.0
                        }
                    transitions_map[key]["count"] += 1
                    transitions_map[key]["total_mins"] += (diff_seconds / 60.0)
            except Exception as e:
                pass
                
    overall_avg_speed = round(sum(calculated_speeds) / len(calculated_speeds), 1) if calculated_speeds else 45.2
    
    route_flows = []
    for key, data in transitions_map.items():
        avg_mins = round(data["total_mins"] / data["count"], 1) if data["count"] > 0 else 0
        route_flows.append({
            "from_camera_id": data["from_camera_id"],
            "from_camera_name": data["from_camera_name"],
            "to_camera_id": data["to_camera_id"],
            "to_camera_name": data["to_camera_name"],
            "count": data["count"],
            "avg_time_mins": avg_mins
        })
        
    # Sort route flows by most common transitions
    route_flows.sort(key=lambda x: x["count"], reverse=True)
    
    cursor.execute("SELECT COUNT(DISTINCT plate_number) as total_vehicles, COUNT(*) as total_detections FROM detections")
    totals = cursor.fetchone()
    conn.close()
    
    return {
        "camera_densities": cameras_summary,
        "heatmap_points": heatmap_points,
        "overall_avg_speed_kmh": overall_avg_speed,
        "total_vehicles": totals["total_vehicles"] if totals else 0,
        "total_detections": totals["total_detections"] if totals else 0,
        "route_flows": route_flows
    }

if __name__ == "__main__":
    init_db()
    print(seed_mock_data())

