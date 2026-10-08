// @vitest-environment node
import { randomUUID } from "node:crypto";
import process from "node:process";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../client";
import { BookingStatus } from "../enums";
import { bookingIdempotencyKeyExtension } from "./booking-idempotency-key";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
}).$extends(bookingIdempotencyKeyExtension());

let userId: number;
const startTime = new Date("2040-01-01T10:00:00.000Z");
const endTime = new Date("2040-01-01T11:00:00.000Z");

function bookingData(status: BookingStatus = BookingStatus.PENDING) {
  return { uid: randomUUID(), title: "Idempotency regression test", userId, startTime, endTime, status };
}

describe("booking acceptance idempotency with PostgreSQL", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `booking-idempotency-${randomUUID()}@example.com` },
      select: { id: true },
    });
    userId = user.id;
  });

  afterEach(async () => {
    if (userId !== undefined) await prisma.booking.deleteMany({ where: { userId } });
  });

  afterAll(async () => {
    try {
      if (userId !== undefined) await prisma.user.delete({ where: { id: userId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("persists the key when accepting with only a status update", async () => {
    const pending = await prisma.booking.create({ data: bookingData(), select: { id: true } });
    await prisma.booking.update({ where: { id: pending.id }, data: { status: BookingStatus.ACCEPTED } });
    const saved = await prisma.booking.findUniqueOrThrow({
      where: { id: pending.id },
      select: { status: true, idempotencyKey: true },
    });
    expect(saved.status).toBe(BookingStatus.ACCEPTED);
    expect(saved.idempotencyKey).toEqual(expect.any(String));
  });

  it("allows only one of two concurrent acceptances for the same organiser and slot", async () => {
    const first = await prisma.booking.create({ data: bookingData(), select: { id: true } });
    const second = await prisma.booking.create({ data: bookingData(), select: { id: true } });
    const results = await Promise.allSettled(
      [first, second].map(({ id }) =>
        prisma.booking.update({ where: { id }, data: { status: BookingStatus.ACCEPTED } })
      )
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "P2002" });
    const bookings = await prisma.booking.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { status: true, idempotencyKey: true },
    });
    expect(bookings.filter((booking) => booking.status === BookingStatus.ACCEPTED)).toHaveLength(1);
    expect(
      bookings.filter(
        (booking) => booking.status === BookingStatus.PENDING && booking.idempotencyKey === null
      )
    ).toHaveLength(1);
  });

  it("rejects acceptance when an equivalent booking was created using ISO date strings", async () => {
    await prisma.booking.create({
      data: {
        ...bookingData(BookingStatus.ACCEPTED),
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      },
    });
    const pending = await prisma.booking.create({ data: bookingData(), select: { id: true } });
    await expect(
      prisma.booking.update({ where: { id: pending.id }, data: { status: BookingStatus.ACCEPTED } })
    ).rejects.toMatchObject({ code: "P2002" });
    const saved = await prisma.booking.findUniqueOrThrow({
      where: { id: pending.id },
      select: { status: true, idempotencyKey: true },
    });
    expect(saved).toEqual({ status: BookingStatus.PENDING, idempotencyKey: null });
  });

  it.each([BookingStatus.CANCELLED, BookingStatus.REJECTED])("releases the key after %s", async (status) => {
    const accepted = await prisma.booking.create({
      data: bookingData(BookingStatus.ACCEPTED),
      select: { id: true },
    });
    const pending = await prisma.booking.create({ data: bookingData(), select: { id: true } });
    await prisma.booking.update({ where: { id: accepted.id }, data: { status } });
    const result = await prisma.booking.update({
      where: { id: pending.id },
      data: { status: BookingStatus.ACCEPTED },
    });
    expect(result.idempotencyKey).toEqual(expect.any(String));
  });
});
