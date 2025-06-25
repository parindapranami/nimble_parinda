FROM python:3.11-slim

WORKDIR /app

# Installations needed for Pillow and basic server functionality
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    libjpeg-dev \
    libpng-dev \
    libtiff-dev \
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