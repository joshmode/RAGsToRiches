FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements-engine.txt .

RUN pip install --no-cache-dir -r requirements-engine.txt

# the embedding model lives in the image, or every rebuilt container downloads it again
ENV HF_HOME=/opt/huggingface
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# load it when the worker starts, not on the first analysis
ENV ENGINE_WARMUP=true

COPY . .

EXPOSE 5001

# no --max-requests: the 30s health checks count as requests, so the only worker
# was recycled about every two hours and the next analysis paid to reload torch
CMD ["gunicorn", "--bind", "0.0.0.0:5001", \
     "--workers", "1", "--threads", "8", "--worker-class", "gthread", \
     "--timeout", "300", \
     "engine_api:app"]
