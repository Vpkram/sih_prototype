import cv2
import numpy as np
import os

def create_sample_video(output_path="sample_traffic.mp4"):
    """
    Generates a 5-second 720p demo traffic video containing moving vehicle shapes
    and clean license plate banners to test YOLOv8 & OCR detection.
    """
    width, height = 1280, 720
    fps = 30
    duration_sec = 5
    total_frames = fps * duration_sec
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
    
    plates = ["KA01AB1234", "KA05MH8899", "DL03CC4567"]
    
    for i in range(total_frames):
        # Road background
        frame = np.full((height, width, 3), (35, 35, 35), dtype=np.uint8)
        
        # Lane markings
        cv2.line(frame, (0, 360), (1280, 360), (255, 255, 255), 2)
        cv2.line(frame, (0, 180), (1280, 180), (200, 200, 200), 1)
        cv2.line(frame, (0, 540), (1280, 540), (200, 200, 200), 1)
        
        # Vehicle 1 (Car rectangle moving left to right)
        car1_x = int((i * 12) % (width + 300)) - 200
        car1_y = 220
        cv2.rectangle(frame, (car1_x, car1_y), (car1_x + 220, car1_y + 110), (180, 50, 50), -1)
        cv2.rectangle(frame, (car1_x + 10, car1_y + 80), (car1_x + 210, car1_y + 105), (250, 250, 250), -1)
        cv2.putText(frame, plates[0], (car1_x + 25, car1_y + 100), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 0, 0), 2)
        
        # Vehicle 2 (Truck rectangle moving right to left)
        car2_x = width - int((i * 10) % (width + 350))
        car2_y = 420
        cv2.rectangle(frame, (car2_x, car2_y), (car2_x + 280, car2_y + 140), (40, 120, 180), -1)
        cv2.rectangle(frame, (car2_x + 30, car2_y + 100), (car2_x + 250, car2_y + 130), (250, 250, 250), -1)
        cv2.putText(frame, plates[1], (car2_x + 45, car2_y + 122), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 0, 0), 2)

        out.write(frame)
        
    out.release()
    print(f"Sample video generated at: {os.path.abspath(output_path)}")

if __name__ == "__main__":
    create_sample_video()
