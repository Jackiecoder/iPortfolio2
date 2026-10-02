"""Run a local demo preview without importing the app or connecting to Postgres.

Usage: venv/bin/python scripts/preview_demo.py
"""
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

ROOT = Path(__file__).resolve().parents[1]
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.mount('/static', StaticFiles(directory=str(ROOT / 'static')), name='static')
templates = Jinja2Templates(directory=str(ROOT / 'templates'))


@app.get('/')
async def index():
    return RedirectResponse('/demo')


@app.get('/demo')
async def demo(request: Request):
    return templates.TemplateResponse('index.html', {'request': request, 'demo_mode': True})


@app.get('/sw.js')
async def service_worker():
    return FileResponse(ROOT / 'static' / 'sw.js', media_type='application/javascript')


@app.api_route('/api/{path:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
async def blocked_api(path: str):
    return JSONResponse({'detail': 'The demo must not make network API requests.'}, status_code=403)


if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=8766)
