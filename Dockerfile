FROM python:3.11-slim

WORKDIR /app

# Installaltions we need for opencv and video
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    libavcodec-dev \
    libavformat-dev \
    libswscale-dev \
    libv4l-dev \
    libxvidcore-dev \
    libx264-dev \
    libjpeg-dev \
    libpng-dev \
    libtiff-dev \
    libatlas-base-dev \
    gfortran \
    wget \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server code and tests
COPY server/ ./server/
COPY tests/ ./tests/

# Make folder for certificates
RUN mkdir -p /app/certs

# Port for the server
EXPOSE 4433

# Set python path
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

# Run the server
CMD ["python", "-m", "server.main", "--cert", "/app/certs/cert.pem", "--key", "/app/certs/key.pem"] 