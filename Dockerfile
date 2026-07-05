# SpendLens — single container serving both the API and the PWA frontend.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ backend/
COPY frontend/ frontend/

# Cloud Run injects $PORT; default 8080 for local docker runs.
ENV PORT=8080
CMD exec uvicorn main:app --app-dir backend --host 0.0.0.0 --port $PORT
