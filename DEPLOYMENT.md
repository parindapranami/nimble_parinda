# Kubernetes Deployment

How to deploy the WebRTC server to kubernetes.

## Required:

- Docker
- kubectl
- A kubernetes cluster (minikube, kind, etc.)

## Using Minikube (easiest)

### Install minikube

```bash
# mac
brew install minikube

# linux
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube
```

### Start minikube

```bash
minikube start
```

### Build and load the image

```bash
# build
docker build -t webrtc-server:latest .

# load into minikube
minikube image load webrtc-server:latest
```

## Deploy

### Quick way

```bash
./deploy.sh
```

### Manual way

```bash
# make certificates
./generate_certs.sh

# create namespace
kubectl apply -f k8s/namespace.yaml

# create secret
kubectl create secret generic webrtc-certs \
  --from-file=cert.pem=certs/cert.pem \
  --from-file=key.pem=certs/key.pem \
  -n webrtc-app

# deploy
kubectl apply -k k8s/
```

## Check if it works

```bash
# see pods
kubectl get pods -n webrtc-app

# see services
kubectl get services -n webrtc-app

# see logs
kubectl logs -f deployment/webrtc-server -n webrtc-app
```

## Access the app

### Minikube

```bash
minikube service webrtc-service -n webrtc-app
```

### Port forward

```bash
kubectl port-forward service/webrtc-service 4433:4433 -n webrtc-app
```

## Clean up

```bash
# delete everything
kubectl delete -k k8s/

# delete namespace
kubectl delete namespace webrtc-app
```
