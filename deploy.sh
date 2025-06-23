#!/bin/bash

echo "Deploying WebRTC server to kubernetes..."

# build docker image
echo "Building docker image..."
docker build -t webrtc-server:latest .

# make certs if they don't exist
if [ ! -f "certs/cert.pem" ]; then
    echo "Making certificates..."
    ./generate_certs.sh
fi

# create namespace
echo "Creating namespace..."
kubectl apply -f k8s/namespace.yaml

# create secret
echo "Creating secret..."
kubectl create secret generic webrtc-certs \
    --from-file=cert.pem=certs/cert.pem \
    --from-file=key.pem=certs/key.pem \
    -n webrtc-app \
    --dry-run=client -o yaml | kubectl apply -f -

# deploy everything
echo "Deploying..."
kubectl apply -k k8s/

echo "Done! Check with: kubectl get pods -n webrtc-app" 