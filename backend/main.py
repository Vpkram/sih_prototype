import os
import shutil
import uuid
import asyncio
import random
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from pydantic import BaseModel

from backend.database import (
    init_db,
    add_detection,
    get_trajectory,
    get_recent_events,
    get_cameras,
    seed_mock_data,
    get_analytics_data,
    add_blacklist_plate,
    get_blacklist,
    get_alerts,
    acknowledge_alerts,
    reset_demo_environment
)
from backend.detector import process_video_and_extract_plates

# Initialize database on startup
init_db()

app = FastAPI(
    title="SIH Prototype - Vehicle Tracking & Trajectory API",
    description="FastAPI Backend for YOLOv8/EasyOCR Vehicle Plate Recognition & Spatial Trajectory Tracking",
    version="1.0.0"
)

# Enable CORS for frontend flexibility
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Directories setup
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads", "videos")
CROPS_DIR = os.path.join(BASE_DIR, "uploads", "crops")
FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "frontend"))

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(CROPS_DIR, exist_ok=True)

# Mount static cropped plate images
app.mount("/static/crops", StaticFiles(directory=CROPS_DIR), name="crops")

# Mount frontend directory static assets if present
if os.path.exists(FRONTEND_DIR):
    app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")


# Live Traffic Simulation Task State
simulation_task = None
simulation_running = False

SAMPLE_PLATES_POOL = [
    "KA05MH8899", "MH12DE9012", "TS07FA5511", "TN09BK7788",
    "UP16AT3344", "HR26DQ1122", "GJ01XY5566", "WB02AZ9988"
]

CAMERA_POOL = ["camera_1", "camera_2", "camera_3", "camera_4", "camera_5"]


async def run_traffic_simulation_loop():
    global simulation_running
    print("[Simulation] Live traffic simulation background task started.")
    while simulation_running:
        try:
            plate = random.choice(SAMPLE_PLATES_POOL)
            cam = random.choice(CAMERA_POOL)
            conf = round(random.uniform(0.91, 0.99), 2)
            add_detection(plate_number=plate, camera_id=cam, confidence=conf)
            print(f"[Simulation] Generated live event: Plate {plate} at {cam} (conf: {conf})")
        except Exception as e:
            print(f"[Simulation Error]: {e}")
        await asyncio.sleep(random.randint(5, 8))


@app.on_event("startup")
async def startup_event():
    global simulation_task, simulation_running
    seed_mock_data()
    simulation_running = True
    simulation_task = asyncio.create_task(run_traffic_simulation_loop())


@app.post("/simulation/start")
async def start_simulation():
    global simulation_task, simulation_running
    if not simulation_running:
        simulation_running = True
        simulation_task = asyncio.create_task(run_traffic_simulation_loop())
    return {"status": "running", "running": True}


@app.post("/simulation/stop")
async def stop_simulation():
    global simulation_task, simulation_running
    simulation_running = False
    if simulation_task:
        simulation_task.cancel()
        simulation_task = None
    return {"status": "stopped", "running": False}


@app.get("/simulation/status")
def simulation_status():
    global simulation_running
    return {"running": simulation_running}



@app.get("/")
def read_root():
    """Serves the main Leaflet dashboard frontend HTML page."""
    index_file = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"message": "SIH Vehicle Tracking API is running. Access /docs for API documentation."}


@app.get("/cameras")
def fetch_cameras():
    """Returns all fixed camera markers with lat/lng coordinates."""
    cameras = get_cameras()
    return {"cameras": cameras}


class BlacklistRequest(BaseModel):
    plate_number: str
    reason: str = "Flagged by Law Enforcement"


@app.post("/blacklist")
def add_to_blacklist(req: BlacklistRequest):
    """Adds a vehicle plate number to the blacklist with a specified reason."""
    res = add_blacklist_plate(req.plate_number, req.reason)
    if not res:
        raise HTTPException(status_code=400, detail="Invalid plate number")
    return res


@app.get("/blacklist")
def fetch_blacklist():
    """Returns all blacklisted vehicle plates."""
    return {"blacklist": get_blacklist()}


@app.get("/alerts")
def fetch_alerts(limit: int = 50):
    """Returns recent intelligent security alerts (blacklisted vehicle hits, suspicious route detections)."""
    return get_alerts(limit=limit)


@app.post("/alerts/acknowledge")
def acknowledge_all_alerts():
    """Marks all active alerts as acknowledged/read."""
    return acknowledge_alerts()


@app.get("/analytics")
def fetch_analytics():
    """Returns aggregated traffic analytics: density per camera, heatmap points, estimated avg speed, and route flows."""
    return get_analytics_data()



@app.get("/trajectory/{plate_number}")
def fetch_trajectory(plate_number: str):
    """
    Returns all detection events for the specified plate number across all cameras,
    sorted chronologically by timestamp.
    """
    trajectory = get_trajectory(plate_number)
    if not trajectory:
        return {
            "plate_number": plate_number.upper(),
            "found": False,
            "count": 0,
            "trajectory": []
        }
    return {
        "plate_number": plate_number.upper(),
        "found": True,
        "count": len(trajectory),
        "trajectory": trajectory
    }


@app.get("/events")
def fetch_events(limit: int = 50):
    """Returns recent detections for the live dashboard feed."""
    events = get_recent_events(limit=limit)
    return {"count": len(events), "events": events}


@app.post("/detect")
async def detect_vehicles(
    file: UploadFile = File(...),
    camera_id: str = Form("camera_1")
):
    """
    POST /detect
    Accepts a video file, runs YOLOv8 vehicle detection & EasyOCR plate extraction frame-by-frame,
    and inserts detected (plate_number, camera_id, timestamp) rows into SQLite DB.
    """
    if not file.filename.endswith(('.mp4', '.avi', '.mov', '.mkv', '.webm')):
        raise HTTPException(status_code=400, detail="Invalid video file format. Please upload .mp4, .avi, or .mov")

    file_ext = os.path.splitext(file.filename)[1]
    saved_video_name = f"video_{uuid.uuid4().hex[:8]}{file_ext}"
    saved_video_path = os.path.join(UPLOADS_DIR, saved_video_name)

    # Save uploaded file
    with open(saved_video_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Process video with detector pipeline
    detections = process_video_and_extract_plates(saved_video_path, camera_id)

    # Save detections to database
    saved_records = []
    for item in detections:
        rec = add_detection(
            plate_number=item["plate_number"],
            camera_id=camera_id,
            timestamp=item["timestamp"],
            confidence=item["confidence"],
            crop_path=item["crop_path"]
        )
        if rec:
            saved_records.append(rec)

    return {
        "success": True,
        "filename": file.filename,
        "camera_id": camera_id,
        "detected_count": len(saved_records),
        "detections": saved_records
    }


@app.post("/seed-demo")
def trigger_seed_demo():
    """Seeds sample vehicle trajectories into the database for immediate interactive testing."""
    msg = seed_mock_data(force=True)
    return {"message": msg}


@app.post("/reset-demo")
def trigger_reset_demo():
    """Resets the demo environment: re-seeds clean trajectories for sample plates and clears unread alerts."""
    msg = reset_demo_environment()
    return {"message": msg}



if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
