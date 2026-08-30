-- Reset admin password to "Admin@123" (bcrypt hash) and mustChangePassword=true
UPDATE "User"
SET password = '$2a$12$abcdefghijklmnopqrstuv', -- placeholder, will be replaced
    "mustChangePassword" = true
WHERE username = 'admin';