// @vitest-environment node
import { PrismaPg } from "@prisma/adapter-pg";
import { v5 as uuidv5 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../client";
import { BookingStatus } from "../enums";
import { bookingIdempotencyKeyExtension } from "./booking-idempotency-key";

const startTime = new Date("2030-01-01T10:00:00.000Z");
const endTime = new Date("2030-01-01T11:00:00.000Z");
const savedBooking = { startTime, endTime, userId: 42, reassignById: 7, status: BookingStatus.PENDING };
const findUnique = vi.fn();
const query = vi.fn();

const baseClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: "postgresql://unused:unused@localhost/unused" }),
}).$extends({
  query: {
    booking: { findUnique: ({ args }) => findUnique(args) },
  },
});
const prisma = baseClient.$extends(bookingIdempotencyKeyExtension()).$extends({
  query: {
    booking: {
      create: ({ args }) => query(args),
      update: ({ args }) => query(args),
      updateMany: ({ args }) => query(args),
    },
  },
});

function expectedKey({
  startTime: start = startTime,
  endTime: end = endTime,
  userId = 42,
  reassignById = 7,
}: {
  startTime?: Date;
  endTime?: Date;
  userId?: number | null;
  reassignById?: number | null;
} = {}) {
  return uuidv5(
    `${start.valueOf()}.${end.valueOf()}.${userId ?? undefined}${reassignById ? `.${reassignById}` : ""}`,
    uuidv5.URL
  );
}

describe("booking idempotency key", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    findUnique.mockResolvedValue(savedBooking);
    query.mockImplementation(async (args) => args.data);
  });

  it("generates a key for a status-only acceptance using the persisted booking", async () => {
    const result = await prisma.booking.update({
      where: { uid: "pending-booking" },
      data: { status: BookingStatus.ACCEPTED },
    });
    expect(result.idempotencyKey).toBe(expectedKey());
    expect(findUnique).toHaveBeenCalledWith({
      where: { uid: "pending-booking" },
      select: { startTime: true, endTime: true, userId: true, reassignById: true, status: true },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("uses new dates supplied during acceptance", async () => {
    const newStart = new Date("2030-01-02T10:00:00.000Z");
    const newEnd = new Date("2030-01-02T11:00:00.000Z");
    const result = await prisma.booking.update({
      where: { id: 1 },
      data: { status: BookingStatus.ACCEPTED, startTime: newStart, endTime: newEnd },
    });
    expect(result.idempotencyKey).toBe(expectedKey({ startTime: newStart, endTime: newEnd }));
  });

  it("handles Prisma set operations for status, dates and organiser IDs", async () => {
    const newStart = new Date("2030-01-02T10:00:00.000Z");
    const result = await prisma.booking.update({
      where: { id: 1 },
      data: {
        status: { set: BookingStatus.ACCEPTED },
        startTime: { set: newStart.toISOString() },
        userId: { set: 99 },
        reassignById: { set: null },
      },
    });
    expect(result.idempotencyKey).toBe(expectedKey({ startTime: newStart, userId: 99, reassignById: null }));
  });

  it("preserves explicit null when clearing reassignment during acceptance", async () => {
    const result = await prisma.booking.update({
      where: { id: 1 },
      data: { status: BookingStatus.ACCEPTED, reassignById: null },
    });
    expect(result.idempotencyKey).toBe(expectedKey({ reassignById: null }));
  });

  it("gives equivalent Date and ISO inputs the same key for create and acceptance", async () => {
    const created = await prisma.booking.create({
      data: {
        uid: "accepted-booking",
        title: "Meeting",
        status: BookingStatus.ACCEPTED,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        user: { connect: { id: 42 } },
        reassignBy: { connect: { id: 7 } },
      },
    });
    const accepted = await prisma.booking.update({
      where: { id: 1 },
      data: { status: BookingStatus.ACCEPTED },
    });
    expect(created.idempotencyKey).toBe(expectedKey());
    expect(accepted.idempotencyKey).toBe(created.idempotencyKey);
  });

  it("uses scalar organiser IDs on unchecked creates", async () => {
    const result = await prisma.booking.create({
      data: {
        uid: "accepted-booking",
        title: "Meeting",
        status: BookingStatus.ACCEPTED,
        startTime,
        endTime,
        userId: 42,
        reassignById: 7,
      },
    });
    expect(result.idempotencyKey).toBe(expectedKey());
  });

  it.each([BookingStatus.CANCELLED, BookingStatus.REJECTED])("clears the key on %s", async (status) => {
    await prisma.booking.update({ where: { id: 1 }, data: { status } });
    expect(query).toHaveBeenCalledWith({ where: { id: 1 }, data: { status, idempotencyKey: null } });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([
    BookingStatus.CANCELLED,
    BookingStatus.REJECTED,
  ])("clears the key on a set to %s", async (status) => {
    await prisma.booking.update({ where: { id: 1 }, data: { status: { set: status } } });
    expect(query).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: { set: status }, idempotencyKey: null },
    });
  });

  it("leaves unrelated updates untouched without querying the booking", async () => {
    const args = { where: { id: 1 }, data: { title: "Updated title" } };
    await prisma.booking.update(args);
    expect(query).toHaveBeenCalledWith(args);
    expect(query.mock.calls[0][0].data).not.toHaveProperty("idempotencyKey");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("does not regenerate the key on an already accepted booking", async () => {
    findUnique.mockResolvedValue({ ...savedBooking, status: BookingStatus.ACCEPTED });
    await prisma.booking.update({ where: { id: 1 }, data: { status: BookingStatus.ACCEPTED } });
    expect(query.mock.calls[0][0].data).not.toHaveProperty("idempotencyKey");
  });

  it("preserves Prisma's update error when the booking does not exist", async () => {
    findUnique.mockResolvedValue(null);
    const error = new Error("Record to update not found");
    query.mockRejectedValue(error);
    await expect(
      prisma.booking.update({ where: { id: 1 }, data: { status: BookingStatus.ACCEPTED } })
    ).rejects.toBe(error);
  });

  it.each([
    BookingStatus.CANCELLED,
    BookingStatus.REJECTED,
  ])("keeps clearing keys in bulk on %s", async (status) => {
    await prisma.booking.updateMany({ where: { userId: 42 }, data: { status } });
    expect(query).toHaveBeenCalledWith({ where: { userId: 42 }, data: { status, idempotencyKey: null } });
  });
});
