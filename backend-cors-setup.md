# Backend Configuration Notes

## CORS — `ALLOWED_ORIGINS`

Currently set to localhost only. Add your Vercel domain:

```
ALLOWED_ORIGINS=https://your-site.vercel.app,https://yourdomain.co.nz
```

## `FRONTEND_URL`

Currently `http://localhost:5173/`. Update to your production URL:

```
FRONTEND_URL=https://yourdomain.co.nz/
```

This is used for email verification redirects.
