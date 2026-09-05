"""Generate a self-signed TLS cert for NetConsole nginx frontend.

Self-signed, so browser will show a warning when accessed over HTTPS. That's
acceptable for an internal/banking-pilot deployment where encryption matters
more than trust-chain verification. Replace with Let's Encrypt once a real
domain is pointed at 42.119.165.109.

Output:
  frontend/certs/cert.pem  -- public cert (PEM)
  frontend/certs/key.pem   -- private key (PEM, no passphrase)

SAN entries: localhost, netconsole-vps, 127.0.0.1, 10.10.20.20, 42.119.165.109
Validity:   365 days from now
"""

from datetime import datetime, timedelta, timezone
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
import ipaddress
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent
CERT_PATH = OUT_DIR / "cert.pem"
KEY_PATH = OUT_DIR / "key.pem"

# 1. Generate RSA private key (2048 bits)
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

# 2. Build subject + issuer (self-signed => same)
subject = issuer = x509.Name(
    [
        x509.NameAttribute(NameOID.COUNTRY_NAME, "VN"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Tai Loc Bank"),
        x509.NameAttribute(NameOID.COMMON_NAME, "netconsole-vps"),
    ]
)

# 3. Build cert with SAN
cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=5))
    .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
    .add_extension(
        x509.SubjectAlternativeName(
            [
                x509.DNSName("localhost"),
                x509.DNSName("netconsole-vps"),
                x509.DNSName("netconsole"),
                x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                x509.IPAddress(ipaddress.IPv4Address("10.10.20.20")),
                x509.IPAddress(ipaddress.IPv4Address("42.119.165.109")),
            ]
        ),
        critical=False,
    )
    .add_extension(
        x509.BasicConstraints(ca=False, path_length=None),
        critical=True,
    )
    .add_extension(
        x509.KeyUsage(
            digital_signature=True,
            key_encipherment=True,
            content_commitment=False,
            data_encipherment=False,
            key_agreement=False,
            key_cert_sign=False,
            crl_sign=False,
            encipher_only=False,
            decipher_only=False,
        ),
        critical=True,
    )
    .add_extension(
        x509.ExtendedKeyUsage([x509.ExtendedKeyUsageOID.SERVER_AUTH]),
        critical=False,
    )
    .sign(private_key=key, algorithm=hashes.SHA256())
)

# 4. Write to disk
CERT_PATH.write_bytes(
    cert.public_bytes(serialization.Encoding.PEM)
)
KEY_PATH.write_bytes(
    key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
)

# 5. Restrict key file perms (best-effort on Windows; chmod no-op there)
try:
    KEY_PATH.chmod(0o600)
except OSError:
    pass

print(f"OK: wrote {CERT_PATH} ({len(CERT_PATH.read_bytes())} bytes)")
print(f"OK: wrote {KEY_PATH}  ({len(KEY_PATH.read_bytes())} bytes)")
print(
    f"Validity: {cert.not_valid_before_utc.isoformat()} -> "
    f"{cert.not_valid_after_utc.isoformat()}"
)
