import { v5 as uuidv5 } from "uuid";
import { Prisma } from "../client";
import { BookingStatus } from "../enums";

function generateIdempotencyKey({
  startTime,
  endTime,
  userId,
  reassignedById,
}: {
  startTime: Date | string;
  endTime: Date | string;
  userId?: number | null;
  reassignedById?: number | null;
}) {
  return uuidv5(
    `${new Date(startTime).valueOf()}.${new Date(endTime).valueOf()}.${userId ?? undefined}${
      reassignedById ? `.${reassignedById}` : ""
    }`,
    uuidv5.URL
  );
}

function resolveDate(
  value: Date | string | Prisma.DateTimeFieldUpdateOperationsInput | undefined,
  fallback: Date
) {
  if (value === undefined) return fallback;
  return typeof value === "object" && !(value instanceof Date) ? (value.set ?? fallback) : value;
}

function resolveId(
  value: number | null | Prisma.NullableIntFieldUpdateOperationsInput | undefined,
  fallback: number | null
) {
  if (value === undefined) return fallback;
  if (value === null || typeof value === "number") return value;
  return value.set !== undefined ? value.set : fallback;
}

export function bookingIdempotencyKeyExtension() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      query: {
        booking: {
          async create({ args, query }) {
            if (args.data.status === BookingStatus.ACCEPTED) {
              const idempotencyKey = generateIdempotencyKey({
                startTime: args.data.startTime,
                endTime: args.data.endTime,
                userId: args.data.user?.connect?.id ?? args.data.userId,
                reassignedById: args.data.reassignBy?.connect?.id ?? args.data.reassignById,
              });
              args.data.idempotencyKey = idempotencyKey;
            }
            return query(args);
          },
          async update({ args, query }) {
            const status = typeof args.data.status === "object" ? args.data.status.set : args.data.status;
            if (status === BookingStatus.CANCELLED || status === BookingStatus.REJECTED) {
              args.data.idempotencyKey = null;
              return query(args);
            }
            if (status !== BookingStatus.ACCEPTED) return query(args);

            const booking = await client.booking.findUnique({
              where: args.where,
              select: { startTime: true, endTime: true, userId: true, reassignById: true, status: true },
            });
            if (!booking || booking.status !== BookingStatus.PENDING) return query(args);

            args.data.idempotencyKey = generateIdempotencyKey({
              startTime: resolveDate(args.data.startTime, booking.startTime),
              endTime: resolveDate(args.data.endTime, booking.endTime),
              userId: resolveId(args.data.userId, booking.userId),
              reassignedById: resolveId(args.data.reassignById, booking.reassignById),
            });
            return query(args);
          },
          async updateMany({ args, query }) {
            const status = typeof args.data.status === "object" ? args.data.status.set : args.data.status;
            if (status === BookingStatus.CANCELLED || status === BookingStatus.REJECTED) {
              args.data.idempotencyKey = null;
            }
            return query(args);
          },
        },
      },
    })
  );
}
