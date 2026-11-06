try {
  const response = await fetch('http://127.0.0.1:8788/ready', { signal: AbortSignal.timeout(3000) });
  const result = await response.json();
  process.stdout.write(JSON.stringify(result));
  if (!response.ok || !result.ready) process.exitCode = 1;
} catch { process.stdout.write(JSON.stringify({ ready: false, error: 'supervisor unavailable' })); process.exitCode = 1; }
