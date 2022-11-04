import { createLogger, transports, format } from 'winston';

export const logger = createLogger({
	transports: [new transports.Console()],
	format: format.combine(
		format.colorize(),
		format.timestamp(),
		format.printf(({ timestamp, level, message }) => {
			return `[${timestamp}] ${level}: ${message}`;
		})
	),
});

export const setLogLevel = (logLevel: string) => {
	logger.level = logLevel;
};

// TODO: see https://grafana.com/blog/2022/07/07/how-to-configure-grafana-loki-with-a-node.js-e-commerce-app/ for Loki Logging
