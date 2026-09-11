@echo off
ssh -i "%USERPROFILE%\.ssh\id_ed25519" -o "StrictHostKeyChecking=no" sonnx@100.102.133.86 "docker exec netconsole-worker python3 -c 'import socket; s = socket.socket(); s.settimeout(1); r = s.connect_ex((\"10.10.20.20\", 22)); print(f\"Port 22: {\"open\" if r==0 else \"closed\"}\"); s.close()'"
