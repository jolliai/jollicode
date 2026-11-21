import { expect, test } from "bun:test"
import { taskOrderCopy } from "../../src/util/task-order"

test("uses complete English and Spanish sentences for terminal order holds", () => {
  expect(taskOrderCopy("Review materials", "en_US.UTF-8")).toEqual({
    waiting: "Waiting",
    submitFirst: "Submit Review materials first",
    optionalSubmitFirst: "Optional · Submit Review materials first",
    refusal: "Tasks in this assignment go in order. Submit Review materials first.",
  })
  expect(taskOrderCopy("Repasar los materiales", "es_MX.UTF-8")).toEqual({
    waiting: "En espera",
    submitFirst: "Envía primero Repasar los materiales",
    optionalSubmitFirst: "Opcional · Envía primero Repasar los materiales",
    refusal: "Los ejercicios de esta tarea se hacen en orden. Envía primero Repasar los materiales.",
  })
  expect(taskOrderCopy("Task 1", "es-ES").waiting).toBe("En espera")
  expect(taskOrderCopy("Task 1", "de_DE.UTF-8").waiting).toBe("Waiting")
})
