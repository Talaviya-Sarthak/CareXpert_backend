import rateLimit from 'express-rate-limit';

export const globalRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 500, 
    standardHeaders: true, 
    legacyHeaders: false, 
    message: 'Too many requests from this IP, please try again later.',
});
