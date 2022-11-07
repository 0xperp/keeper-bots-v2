import { createLogger, transports, format } from 'winston';
import LokiTransport from "winston-loki"

export const logger = createLogger({
	transports: [
		new transports.Console({
			format: format.combine(
				format.colorize(),
				format.timestamp(),
				format.printf(({ timestamp, level, message }) => {
					return `[${timestamp}] ${level}: ${message}`;
				}))
		}),
		new LokiTransport({
			host: "http://127.0.0.1:3100",
			labels: { app: 'jit'},
			json: true,
			format: format.json(),
			replaceTimestamp: true,
			onConnectionError: (err) => console.error(err)
		}),
	],
});

export const setLogLevel = (logLevel: string) => {
	logger.level = logLevel;
};