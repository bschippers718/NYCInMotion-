# NYC in Motion - one container: the Python server, its pollers and the compiled data.
# Build context excludes the raw source downloads (see .dockerignore); the compiled
# data/*.json, taxi_flow.duckdb and streets/ are copied in (~270 MB).
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 HOST=0.0.0.0 PORT=8000

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY subway ./subway
COPY web ./web
COPY data ./data

EXPOSE 8000
CMD ["python", "server.py"]
