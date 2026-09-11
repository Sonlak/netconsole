import psycopg2
conn = psycopg2.connect(
    host="10.10.20.20",
    port=5432,
    dbname="netconsole",
    user="netconsole",
    password="netconsole"
)
cur = conn.cursor()
cur.execute("""
SELECT "createdAt", "sourceIp", message
FROM "DeviceLog"
WHERE message LIKE '%ssh%'
ORDER BY "createdAt" DESC
LIMIT 10
""")
for row in cur.fetchall():
    print(row)
conn.close()
